-- 2.0 上线前：冻结「经验展示下限」+ 历史数据按新规则归一化
--
-- 背景：
--   * 经验规则已切到服务端口径（20260916160000），但历史数据口径不一致：
--     日常投稿有 671 条是 80 经验/篇（规则是 40）、历史提问 295 条是 0 经验（规则是 20/题）。
--   * 直接归一化会让 47 位答主的「展示经验」下降（他们当前展示值里有 80/篇的旧口径成分）。
--   * 用户口径：存量答主的经验「是多少就固定多少，不削减」。所以先把每人当前的展示值冻结成下限。
--
-- 做法：
--   1) keyflow_answerers 增加 exp_floor：冻结 = max(当前服务端经验, 旧公式值)，只对还没冻结过的行执行。
--   2) 历史数据归一化：日常投稿 → 40，提问 → 20。
--   3) 看板 RPC 返回 exp_floor；前端展示 = max(服务端经验, exp_floor)。
--   之后想让展示完全跟随新规则，把 exp_floor 全置 0（或前端去掉 max）即可。

begin;

-- ---------- 1. 冻结展示下限 ----------
alter table public.keyflow_answerers
  add column if not exists exp_floor bigint not null default 0;

update public.keyflow_answerers a
   set exp_floor = greatest(
     public.keyflow_answerer_exp(a.id),
     -- 旧展示公式（入选才算参与 / 交付按条数 / 日常投稿 80）
     (select count(distinct app.activity_id) * 50 from public.keyflow_applications app
       where app.answerer_id = a.id and app.status = 'selected')
     + (select count(*) * 300 from public.keyflow_applications app
         join public.keyflow_deliveries d on d.application_id = app.id
        where app.answerer_id = a.id)
     + (select count(*) * 80 from public.keyflow_daily_submissions ds
         where ds.answerer_id = a.id)
   )
 where a.exp_floor = 0;

-- ---------- 2. 历史数据按规则归一化 ----------
update public.keyflow_daily_submissions set xp_value = 40 where xp_value <> 40;
update public.keyflow_daily_questions set xp_value = 20 where xp_value <> 20;

-- ---------- 3. 看板返回 exp_floor ----------
create or replace function public.keyflow_answerer_dashboard(p_answerer_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_answerer public.keyflow_answerers;
begin
  select * into v_answerer
  from public.keyflow_answerers
  where id = p_answerer_id;

  if v_answerer.id is null then
    raise exception '答主不存在';
  end if;

  return jsonb_build_object(
    'answerer', jsonb_build_object('id', v_answerer.id, 'zhihu_name', v_answerer.zhihu_name, 'avatar_url', v_answerer.avatar_url, 'dashboard_cover_url', v_answerer.dashboard_cover_url),
    -- 与经验规则一致：报名就算（不再只算入选）
    'participated_count', (select count(distinct app.activity_id) from public.keyflow_applications app where app.answerer_id = p_answerer_id),
    -- 与经验规则一致：交稿就算，按活动去重
    'submission_count', (select count(distinct app.activity_id) from public.keyflow_applications app join public.keyflow_deliveries d on d.application_id = app.id where app.answerer_id = p_answerer_id),
    -- 日常内容投稿（含综合活动投稿）
    'daily_submission_count', (
      (select count(*) from public.keyflow_daily_submissions where answerer_id = p_answerer_id)
      + (select count(*) from public.keyflow_comprehensive_submissions where answerer_id = p_answerer_id)
    ),
    'question_submission_count', (
      select count(*)
      from public.keyflow_daily_questions
      where answerer_id = p_answerer_id
        and content_type = 'question'
    ),
    -- 展示下限：上线时冻结的存量经验，保证数字不回落
    'exp_floor', v_answerer.exp_floor,
    'activities', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', a.id,
        'title', a.title,
        'game_name', a.game_name,
        'game_cover', a.game_cover,
        'status', a.status,
        'delivery_deadline', a.delivery_deadline,
        'application_status', app.status,
        'key_claimed', k.claimed_at is not null
      ) order by app.submitted_at desc)
      from public.keyflow_applications app
      join public.keyflow_activities a on a.id = app.activity_id
      left join public.keyflow_keys k on k.application_id = app.id
      left join public.keyflow_deliveries d on d.application_id = app.id
      where app.answerer_id = p_answerer_id
        and d.id is null
        and app.status != 'rejected'
        and (a.status != 'completed' or a.exempted_answerer_ids ? p_answerer_id::text)
    ), '[]'::jsonb)
  );
end;
$$;

commit;
