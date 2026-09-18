-- 经验外显口径切换（2026-09-18）
--
-- 需求（用户口径）：以「切换那一刻每个人现在的外显经验」作为基数，等级按这个外显经验匹配；
--   之后按真实任务完成情况在这个基数上继续加。
--
-- 为什么改：旧口径 外显 = max(真实经验, exp_floor)。exp_floor 是 09-16 冻结的存量值，
--   对 66 位答主来说它比真实经验高出一大截，于是新投稿的 +40 全被压在下面看不见
--   （典型：韩信 外显 7950 / 真实 7010，要再攒 940 才会动；一只古零 3260 / 2220）。
--
-- 新口径：
--   外显经验 = exp_floor(切换基线) + greatest(0, 当前真实经验 - exp_base_real(切换时的真实经验))
--     · 切换当天外显值与切换前完全一致（零变化，已验证）
--     · 之后每完成一个任务 +N 立刻显示
--     · 真实经验因运营清理回落时不显示下降（增量按 0 计）
--     · 等级仍按外显经验匹配 → 不会掉级
--
-- 备份：切换前的 (下限 / 真实 / 外显) 全量快照存进 keyflow_answerer_exp_baseline_20260918
-- 存档：codex-trae-sync/投稿逻辑0918存档/

begin;

-- ---------- 1. 切换前快照（对账 / 回滚用，重复执行不会覆盖首次快照） ----------
create table if not exists public.keyflow_answerer_exp_baseline_20260918 (
  answerer_id uuid primary key,
  zhihu_name text,
  exp_floor bigint,
  real_exp bigint,
  shown_exp bigint,
  captured_at timestamptz not null default now()
);

insert into public.keyflow_answerer_exp_baseline_20260918 (answerer_id, zhihu_name, exp_floor, real_exp, shown_exp)
select a.id,
       a.zhihu_name,
       coalesce(a.exp_floor, 0),
       public.keyflow_answerer_exp(a.id),
       greatest(coalesce(a.exp_floor, 0), public.keyflow_answerer_exp(a.id))
from public.keyflow_answerers a
on conflict (answerer_id) do nothing;

-- ---------- 2. 记下切换时的真实经验，并把 exp_floor 抬成「切换前的外显值」 ----------
alter table public.keyflow_answerers add column if not exists exp_base_real bigint;

-- 只处理还没切换过的行（exp_base_real is null）；同一语句取同一快照，避免基数错位
update public.keyflow_answerers a
   set exp_base_real = s.real_exp,
       exp_floor = greatest(coalesce(a.exp_floor, 0), s.real_exp)
  from (
    select a2.id, public.keyflow_answerer_exp(a2.id) as real_exp
    from public.keyflow_answerers a2
    where a2.exp_base_real is null
  ) s
 where a.id = s.id;

alter table public.keyflow_answerers alter column exp_base_real set default 0;
update public.keyflow_answerers set exp_base_real = 0 where exp_base_real is null;
alter table public.keyflow_answerers alter column exp_base_real set not null;

comment on column public.keyflow_answerers.exp_base_real is
  '2026-09-18 经验外显切换时的真实经验。外显经验 = exp_floor + greatest(0, 真实经验 - exp_base_real)。新答主默认 0。';
comment on column public.keyflow_answerers.exp_floor is
  '2026-09-16 冻结、2026-09-18 起作为「外显经验基线」：外显 = 本列 + greatest(0, 真实经验 - exp_base_real)。';

-- ---------- 3. 外显经验函数 ----------
create or replace function public.keyflow_answerer_display_exp(p_answerer_id uuid)
returns bigint
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(a.exp_floor, 0)
       + greatest(0, public.keyflow_answerer_exp(a.id) - coalesce(a.exp_base_real, 0))
  from public.keyflow_answerers a
  where a.id = p_answerer_id;
$$;

comment on function public.keyflow_answerer_display_exp(uuid) is
  '答主外显经验 = 切换基线 + 切换后新增的真实经验（只增不减）。等级按这个值匹配。';

grant execute on function public.keyflow_answerer_display_exp(uuid) to anon, authenticated;

-- ---------- 4. 看板 RPC 增加 display_exp（其余部分与线上逐字一致） ----------
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
    -- 外显经验（2026-09-18 起）：切换基线 + 切换后新增的真实经验；前端直接用这个值算等级
    'display_exp', public.keyflow_answerer_display_exp(p_answerer_id),
    -- 兼容保留：冻结基线（= 切换前的外显值），前端仅在拿不到 display_exp 时兜底
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

grant execute on function public.keyflow_answerer_dashboard(uuid) to anon, authenticated;

-- ---------- 5. 后台「等级一览」统一到同一套外显口径 ----------
-- 原来用的是第三套公式（报名×50 + 交付×300 + 日常投稿×80），和答主端、真实值都对不上。
-- 这里做函数体替换：找不到目标表达式就直接报错回滚，避免静默改错。
do $$
declare
  v_def text;
  v_new text;
begin
  v_def := pg_get_functiondef('public.keyflow_admin_analytics_overview(text,text)'::regprocedure);
  if position('keyflow_answerer_display_exp' in v_def) > 0 then
    raise notice 'answerer_levels 已经用过外显口径，跳过';
    return;
  end if;
  v_new := replace(
    v_def,
    '(coalesce(p.cnt, 0) * 50 + coalesce(s.cnt, 0) * 300 + coalesce(ds.cnt, 0) * 80)::integer as points',
    '(public.keyflow_answerer_display_exp(a.id))::integer as points'
  );
  if v_new = v_def then
    raise exception '未找到 answerer_levels 的 points 表达式，迁移中止';
  end if;
  execute v_new;
end $$;

commit;

-- 自检：切换前后外显值必须完全一致（差 0 人），抽样看几个答主
select jsonb_build_object(
  'snapshot_rows', (select count(*) from public.keyflow_answerer_exp_baseline_20260918),
  'switched_rows', (select count(*) from public.keyflow_answerers where exp_base_real is not null),
  'display_mismatch', (
    select count(*) from public.keyflow_answerer_exp_baseline_20260918 b
    where public.keyflow_answerer_display_exp(b.answerer_id) <> b.shown_exp
  ),
  'samples', (
    select jsonb_agg(jsonb_build_object(
      'name', x.zhihu_name, '切换前外显', x.shown_exp, '切换后外显', x.now_exp, '真实经验', x.real_exp))
    from (
      select a.zhihu_name, b.shown_exp, b.real_exp, public.keyflow_answerer_display_exp(a.id) as now_exp
      from public.keyflow_answerers a
      join public.keyflow_answerer_exp_baseline_20260918 b on b.answerer_id = a.id
      where a.zhihu_name in ('韩信', '一只古零', '白翎GameUX', '轩子', '35岁阴郁少女')
    ) x
  )
) as applied;
