-- 经验外显基数修正（2026-09-18）
--
-- 用户口径：以 09-15 收盘的存量（冻结下限 exp_floor）为基础，
--   09-15 之后产生的所有投稿继续按新规则（日常投稿 40/篇 等）累加。
--
-- 问题：20260918140000 把 exp_base_real 取成「09-18 切换那一刻的真实经验」，
--   于是 09-16 00:00 ~ 09-18 切换之间新增的经验全被基数吃掉，答主端看不到。
--   典型：一只古零 09-16 曾冻结 3260（= 2×50 + 2×300 + 32篇×80），
--   09-16 3 篇 + 09-17 3 篇（共 6 篇 × 40 = 240）却停在外显 3260。
--
-- 修法：把 exp_base_real 重算为「09-16 00:00（北京时间）之前产生的经验」。
--   函数形式不变：外显 = exp_floor + greatest(0, 真实经验 - exp_base_real)。
--   · 切换前（09-16 00:00 前）的存量仍由 exp_floor 原样托住，不增不减
--   · 09-15 之后每一篇投稿按新规则立刻体现在外显值上
--   · 真实经验因运营清理回落时不显示下降（greatest(0, ...) 兜底）
--
-- 影响面（执行前已用 codex-trae-sync/verify-exp-rebase-20260918.sql 推演）：
--   195 位答主中 80 位外显值变化、12 位等级上升，合计 +17950。
--
-- 回滚：本迁移不改 exp_floor，只改 exp_base_real；
--   改前的全量 (answerer_id, exp_base_real_old, exp_base_real_new) 存进
--   public.keyflow_answerer_exp_base_real_backup_20260918，按 answerer_id 一条 UPDATE 即可还原。

begin;

-- ---------- 1. 用 09-16 00:00 之前的数据重算每位答主的基数 ----------
create temporary table tmp_exp_base_real_20260918 on commit drop as
with cutoff as (
  select timestamptz '2026-09-16 00:00:00+08' as ts
),
ap as (
  select a.answerer_id, count(distinct a.activity_id) as n
  from public.keyflow_applications a, cutoff
  where a.submitted_at < cutoff.ts
  group by a.answerer_id
),
dl as (
  select a.answerer_id,
         count(distinct a.activity_id) as acts,
         count(*) as cnt
  from public.keyflow_applications a
  join public.keyflow_deliveries d on d.application_id = a.id, cutoff
  where d.submitted_at < cutoff.ts
  group by a.answerer_id
),
ds as (
  select s.answerer_id, sum(s.xp_value) as xp
  from public.keyflow_daily_submissions s, cutoff
  where s.submitted_at < cutoff.ts and s.answerer_id is not null
  group by s.answerer_id
),
q as (
  select q.answerer_id, sum(q.xp_value) as xp
  from public.keyflow_daily_questions q, cutoff
  where q.created_at < cutoff.ts and q.answerer_id is not null
  group by q.answerer_id
),
cs as (
  select c.answerer_id, sum(c.xp_value) as xp
  from public.keyflow_comprehensive_submissions c, cutoff
  where c.submitted_at < cutoff.ts
  group by c.answerer_id
),
rw as (
  select r.answerer_id, sum(r.exp_amount) as xp
  from public.keyflow_activity_completion_rewards r, cutoff
  where r.created_at < cutoff.ts
  group by r.answerer_id
)
select a.id as answerer_id,
       a.zhihu_name,
       coalesce(a.exp_base_real, 0) as base_old,
       coalesce(ap.n, 0) * 50
         + coalesce(dl.acts, 0) * 300
         + greatest(0, coalesce(dl.cnt, 0) - coalesce(dl.acts, 0)) * 40
         + coalesce(q.xp, 0)
         + coalesce(ds.xp, 0)
         + coalesce(cs.xp, 0)
         + coalesce(rw.xp, 0) as base_new
from public.keyflow_answerers a
left join ap on ap.answerer_id = a.id
left join dl on dl.answerer_id = a.id
left join ds on ds.answerer_id = a.id
left join q  on q.answerer_id  = a.id
left join cs on cs.answerer_id = a.id
left join rw on rw.answerer_id = a.id;

-- ---------- 2. 备份（首次执行才写，重复执行不覆盖） ----------
create table if not exists public.keyflow_answerer_exp_base_real_backup_20260918 (
  answerer_id uuid primary key,
  zhihu_name text,
  exp_base_real_old bigint,
  exp_base_real_new bigint,
  captured_at timestamptz not null default now()
);

insert into public.keyflow_answerer_exp_base_real_backup_20260918
  (answerer_id, zhihu_name, exp_base_real_old, exp_base_real_new)
select answerer_id, zhihu_name, base_old, base_new
from tmp_exp_base_real_20260918
on conflict (answerer_id) do nothing;

-- ---------- 3. 回写基数 ----------
update public.keyflow_answerers a
   set exp_base_real = t.base_new
  from tmp_exp_base_real_20260918 t
 where a.id = t.answerer_id
   and a.exp_base_real is distinct from t.base_new;

comment on column public.keyflow_answerers.exp_base_real is
  '经验外显基数：2026-09-16 00:00（北京时间）之前产生的经验。外显经验 = exp_floor + greatest(0, 真实经验 - 本列)。';

commit;

-- ---------- 自检 ----------
select jsonb_build_object(
  'backup_rows', (select count(*) from public.keyflow_answerer_exp_base_real_backup_20260918),
  'base_changed', (
    select count(*) from public.keyflow_answerer_exp_base_real_backup_20260918
    where exp_base_real_old is distinct from exp_base_real_new
  ),
  'display_mismatch', (
    select count(*) from public.keyflow_answerer_exp_base_real_backup_20260918 b
    where public.keyflow_answerer_display_exp(b.answerer_id)
          <> (select coalesce(a.exp_floor, 0) + greatest(0, public.keyflow_answerer_exp(a.id) - b.exp_base_real_new)
              from public.keyflow_answerers a where a.id = b.answerer_id)
  ),
  'samples', (
    select jsonb_agg(jsonb_build_object(
      'name', x.zhihu_name, '外显', x.now_display,
      '等级', public.keyflow_level_from_exp(x.now_display)))
    from (
      select a.zhihu_name, public.keyflow_answerer_display_exp(a.id) as now_display
      from public.keyflow_answerers a
      where a.zhihu_name in ('一只古零', '韩信', '白玉京', '白翎GameUX')
    ) x
  )
) as applied;
