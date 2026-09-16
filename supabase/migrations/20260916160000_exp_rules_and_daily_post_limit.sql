-- 2.0 上线前口径统一（2026-09-16）：
--   经验规则（服务端口径 keyflow_answerer_exp）：
--     1) 已参与活动 50/个 = 报名就算（不再要求 status='selected'，按活动去重）
--     2) 已完成活动 300/个 = 交稿就算（按「有交付的活动」去重，不再按交付条数重复计）
--     3) 已投稿问题 20/题（keyflow_daily_questions.xp_value）
--     4) 日常内容 40/个（keyflow_daily_submissions.xp_value）
--     5) 综合活动：投稿按日常内容 40/个（keyflow_comprehensive_submissions.xp_value）
--        + 完成规定次数后发活动配置的经验（keyflow_activity_completion_rewards.exp_amount）
--   每日投稿上限分档（后台触发 + 前台展示同源）：
--     Lv1=1、Lv2=2、Lv3-5=3、Lv6-7=4、Lv8+=5
--     （原文写「LV6-8 每日4篇 / LV8-10 每日5篇」，LV8 落在两个区间；这里按「后一档生效」处理，
--       即 Lv8 起 5 篇。若要 Lv8=4 篇，把下面 case 的 `level <= 7` 改成 `level <= 8` 即可。）

begin;

-- ---------- 1. 每日投稿上限分档（keyflow_daily_post_limit(level) 直接读这张表） ----------
update public.keyflow_level_config
   set daily_post_limit = case
     when level <= 1 then 1
     when level = 2 then 2
     when level <= 5 then 3
     when level <= 7 then 4
     else 5
   end;

-- ---------- 2. 旧上限触发器改用同一份分档（原来它自带一套「积分门槛」表，会和等级分档打架） ----------
create or replace function public.keyflow_enforce_daily_submission_limit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_day date := (now() at time zone 'Asia/Shanghai')::date;
  v_level integer;
  v_limit integer;
  v_today_count integer;
begin
  if new.answerer_id is null then
    return new;
  end if;

  perform pg_advisory_xact_lock(hashtext(new.answerer_id::text));

  v_level := public.keyflow_display_current_level(new.answerer_id, v_day);
  v_limit := public.keyflow_daily_post_limit(v_level);

  select count(*) into v_today_count
  from public.keyflow_daily_submissions
  where answerer_id = new.answerer_id
    and (created_at at time zone 'Asia/Shanghai') >= date_trunc('day', (now() at time zone 'Asia/Shanghai'));

  if v_today_count >= v_limit then
    raise exception '今日已回答投稿已达上限（Lv% 每天限投 % 条回答）', v_level, v_limit;
  end if;

  return new;
end;
$$;

-- ---------- 3. 经验口径（5 条规则） ----------
create or replace function public.keyflow_answerer_exp(p_answerer_id uuid)
returns bigint
language sql stable
set search_path = public
as $$
  select
    -- 1) 已参与活动：报名就算（含未入选/被拒，按活动去重）
    (select count(distinct activity_id) * 50 from keyflow_applications
      where answerer_id = p_answerer_id)
    -- 2) 已完成活动：交稿就算（按有交付的活动去重）
    + (select count(distinct a.activity_id) * 300 from keyflow_applications a
        join keyflow_deliveries d on d.application_id = a.id
       where a.answerer_id = p_answerer_id)
    -- 3) 已投稿问题：20/题
    + (select coalesce(sum(xp_value), 0) from keyflow_daily_questions
       where answerer_id = p_answerer_id)
    -- 4) 日常内容：40/个
    + (select coalesce(sum(xp_value), 0) from keyflow_daily_submissions
       where answerer_id = p_answerer_id)
    -- 5a) 综合活动投稿：按日常内容 40/个
    + (select coalesce(sum(xp_value), 0) from keyflow_comprehensive_submissions
       where answerer_id = p_answerer_id)
    -- 5b) 综合活动完成奖励经验
    + (select coalesce(sum(exp_amount), 0) from keyflow_activity_completion_rewards
       where answerer_id = p_answerer_id);
$$;

-- ---------- 4. 看板计数与经验口径对齐 ----------
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
    -- 日常内容投稿（含综合活动投稿，口径：综合活动投稿也算一次日常内容）
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
