-- 等级口径统一（2026-09-19）：结算与限额链路全部改用「外显经验」
--
-- 背景：答主端展示等级 = keyflow_level_from_exp(外显经验)，
--   但后端 keyflow_mark_answerer_active 仍按 keyflow_level_from_exp(真实经验) 定上限，
--   导致外显 Lv6 的答主实际按 Lv5 结算（每日活跃金币 417 vs 500、每日投稿上限 3 篇 vs 4 篇）。
--   后台「金币系数」页还留着第三套公式（报名×50 + 交付×300 + 日常投稿×80），同样对不上。
--
-- 本次改动（等级一律只升不降）：
--   1) keyflow_mark_answerer_active：等级上限 v_best 改用外显经验
--   2) 存量对齐：current_level / best_level 抬到外显等级（执行前测得 40 人 current、20 人 best 需抬高，最大差 2 级）
--   3) keyflow_answerer_economy_state：exp / best_level 改用外显经验（新增 real_exp 保留真实值）
--   4) keyflow_admin_coin_scale_levels：废弃第三套公式，改用外显经验
--
-- 回滚：备份表 public.keyflow_answerer_level_backfill_20260919 存了改前的 current_level / best_level
--   以及本次采用的 show_level，一条 UPDATE 即可还原（见文件末尾注释）。

begin;

-- ---------- 1. 活跃结算上限改用外显经验 ----------
CREATE OR REPLACE FUNCTION public.keyflow_mark_answerer_active(
  p_answerer_id uuid,
  p_day date DEFAULT ((now() AT TIME ZONE 'Asia/Shanghai'::text))::date
)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_last date;
  v_cur int;
  v_streak int;
  v_gap int;
  v_inactive int;
  v_best int;
  v_recoverable int;
  v_add int;
  v_coins int;
begin
  select last_active_date, current_level, active_streak
    into v_last, v_cur, v_streak
  from public.keyflow_answerers where id = p_answerer_id;
  if not found then raise exception '答主不存在'; end if;

  if v_last is null then
    v_streak := 1;
  elsif (p_day - v_last) = 1 then
    v_streak := v_streak + 1;
  elsif (p_day - v_last) > 1 then
    v_gap := (p_day - v_last);
    v_inactive := greatest(0, v_gap - 1);
    v_cur := greatest(1, v_cur - (v_inactive / 7));
    v_streak := 1;
  end if;

  -- 2026-09-19 口径统一：等级上限按「外显经验」算，与答主端展示一致
  v_best := public.keyflow_level_from_exp(public.keyflow_answerer_display_exp(p_answerer_id));
  v_recoverable := greatest(0, v_best - v_cur);
  v_add := least(v_recoverable, v_streak / 3);
  v_cur := v_cur + v_add;
  v_coins := public.keyflow_daily_coins(v_cur);

  update public.keyflow_answerers
     set last_active_date = p_day,
         current_level = v_cur,
         active_streak = v_streak,
         best_level = greatest(best_level, v_best)
   where id = p_answerer_id;

  insert into public.keyflow_coins_ledger (answerer_id, amount, source, note)
  values (p_answerer_id, v_coins, 'daily_activity_reward', '活跃日金币 Lv' || v_cur)
  on conflict do nothing;

  return v_cur;
end;
$function$;

-- ---------- 2. 存量等级对齐（只升不降） ----------
create table if not exists public.keyflow_answerer_level_backfill_20260919 (
  answerer_id uuid primary key,
  zhihu_name text,
  current_level_before int,
  best_level_before int,
  show_level int,
  captured_at timestamptz not null default now()
);

insert into public.keyflow_answerer_level_backfill_20260919
  (answerer_id, zhihu_name, current_level_before, best_level_before, show_level)
select a.id,
       a.zhihu_name,
       a.current_level,
       a.best_level,
       public.keyflow_level_from_exp(public.keyflow_answerer_display_exp(a.id))
from public.keyflow_answerers a
on conflict (answerer_id) do nothing;

update public.keyflow_answerers a
   set current_level = greatest(a.current_level, b.show_level),
       best_level = greatest(a.best_level, b.show_level)
  from public.keyflow_answerer_level_backfill_20260919 b
 where b.answerer_id = a.id
   and (a.current_level < b.show_level or a.best_level < b.show_level);

-- ---------- 3. 经济状态改用外显经验 ----------
create or replace function public.keyflow_answerer_economy_state(p_answerer_id uuid)
returns jsonb
language plpgsql
stable security definer
set search_path = public
as $$
declare v_today date := (now() at time zone 'Asia/Shanghai')::date;
begin
  return jsonb_build_object(
    -- 2026-09-19 口径统一：对外的 exp / best_level 一律用外显经验，真实值另给 real_exp
    'exp', public.keyflow_answerer_display_exp(p_answerer_id),
    'real_exp', public.keyflow_answerer_exp(p_answerer_id),
    'best_level', public.keyflow_level_from_exp(public.keyflow_answerer_display_exp(p_answerer_id)),
    'current_level', public.keyflow_display_current_level(p_answerer_id, v_today),
    'coins_balance', public.keyflow_coins_balance(p_answerer_id),
    'last_active_date', (select last_active_date from public.keyflow_answerers where id = p_answerer_id)
  );
end;
$$;

-- ---------- 4. 后台「金币系数」页改用外显经验 ----------
CREATE OR REPLACE FUNCTION public.keyflow_admin_coin_scale_levels(p_token text)
 RETURNS TABLE(level integer, people bigint, today_active_count bigint, month_active_count bigint, today_active_coins bigint, month_active_coins bigint)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_admin uuid;
  v_today date := (now() at time zone 'Asia/Shanghai')::date;
  v_month_start date := date_trunc('month', (now() at time zone 'Asia/Shanghai'))::date;
begin
  v_admin := public.resolve_admin_token(p_token);
  if v_admin is null then
    raise exception '无权操作';
  end if;

  return query
  with valid_active_events as (
    select ds.answerer_id, ds.created_at as event_at
    from public.keyflow_daily_submissions ds
    where ds.answerer_id is not null
    union all
    select app.answerer_id, d.submitted_at as event_at
    from public.keyflow_deliveries d
    join public.keyflow_applications app on app.id = d.application_id
    where app.answerer_id is not null
    union all
    select app.answerer_id, k.claimed_at as event_at
    from public.keyflow_keys k
    join public.keyflow_applications app on app.id = k.application_id
    where app.answerer_id is not null and k.claimed_at is not null
    union all
    select app.answerer_id, app.submitted_at as event_at
    from public.keyflow_applications app
    where app.answerer_id is not null
    union all
    select ro.answerer_id, ro.created_at as event_at
    from public.keyflow_redeem_orders ro
    where ro.answerer_id is not null
  ), event_counts as (
    select e.answerer_id,
           count(*) filter (
             where (e.event_at at time zone 'Asia/Shanghai')::date = v_today
           )::bigint as today_count,
           count(*) filter (
             where (e.event_at at time zone 'Asia/Shanghai')::date >= v_month_start
           )::bigint as month_count
    from valid_active_events e
    group by e.answerer_id
  ), reward_sums as (
    select l.answerer_id,
           coalesce(sum(l.amount) filter (
             where (l.created_at at time zone 'Asia/Shanghai')::date = v_today
           ), 0)::bigint as today_coins,
           coalesce(sum(l.amount) filter (
             where (l.created_at at time zone 'Asia/Shanghai')::date >= v_month_start
           ), 0)::bigint as month_coins
    from public.keyflow_coins_ledger l
    where l.source = 'daily_activity_reward'
    group by l.answerer_id
  ), answerer_points as (
    -- 2026-09-19 口径统一：等级一律按外显经验匹配（原第三套公式已废弃）
    select a.id,
           coalesce(ec.today_count, 0)::bigint as user_today_count,
           coalesce(ec.month_count, 0)::bigint as user_month_count,
           coalesce(rs.today_coins, 0)::bigint as user_today_coins,
           coalesce(rs.month_coins, 0)::bigint as user_month_coins,
           public.keyflow_answerer_display_exp(a.id) as user_points
    from public.keyflow_answerers a
    left join event_counts ec on ec.answerer_id = a.id
    left join reward_sums rs on rs.answerer_id = a.id
  ), answerer_levels as (
    select
      greatest(1, public.keyflow_level_from_exp(user_points)) as user_level,
      user_today_count,
      user_month_count,
      user_today_coins,
      user_month_coins
    from answerer_points
  )
  select
    user_level as level,
    count(*)::bigint as people,
    coalesce(sum(user_today_count), 0)::bigint as today_count,
    coalesce(sum(user_month_count), 0)::bigint as month_count,
    coalesce(sum(user_today_coins), 0)::bigint as today_coins,
    coalesce(sum(user_month_coins), 0)::bigint as month_coins
  from answerer_levels
  group by user_level
  order by user_level;
end;
$function$;

commit;

-- ---------- 自检 ----------
select jsonb_build_object(
  'backfill_rows', (select count(*) from public.keyflow_answerer_level_backfill_20260919),
  'current_raised', (
    select count(*) from public.keyflow_answerer_level_backfill_20260919
    where current_level_before < show_level
  ),
  'best_raised', (
    select count(*) from public.keyflow_answerer_level_backfill_20260919
    where best_level_before < show_level
  ),
  'level_mismatch_after', (
    select count(*) from public.keyflow_answerers a
    where a.current_level < public.keyflow_level_from_exp(public.keyflow_answerer_display_exp(a.id))
  ),
  'target', (
    select jsonb_build_object(
      'name', a.zhihu_name,
      'current_level', a.current_level,
      'best_level', a.best_level,
      'display_exp', public.keyflow_answerer_display_exp(a.id),
      'daily_coins_lv', public.keyflow_daily_coins(a.current_level))
    from public.keyflow_answerers a where a.zhihu_name = '一只古零'
  )
) as applied;

-- 回滚（手动执行）：
-- update public.keyflow_answerers a
--    set current_level = b.current_level_before,
--        best_level = b.best_level_before
--   from public.keyflow_answerer_level_backfill_20260919 b
--  where a.id = b.answerer_id;
-- 再把 keyflow_mark_answerer_active / keyflow_answerer_economy_state / keyflow_admin_coin_scale_levels
-- 换回 20260919000000 之前的版本（见 20260915230000 / 20260908120000 / 20260917233000）。
