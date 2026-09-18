-- 系数设置「产出预估」表：原有 4 列（人数 / 今日活跃次数 / 本月活跃次数）保留，
-- 新增 2 列「实际发放金币」（今日 / 本自然月）。
--
-- 口径说明：
--   * 理论值（前端算）= 该等级【每个】人每天都活跃：人数 × 人均日产出，月 = ×30。
--   * 实际值（本迁移）= keyflow_coins_ledger 里 source='daily_activity_reward' 的金额合计，
--     按答主的经验值等级归行（与「人数」「活跃次数」同一等级口径，全表口径一致）。
--   * 金币每人每天只发一次（唯一索引 coins_ledger_daily_unique + mark_answerer_active 的
--     on conflict do nothing），所以实际值只会小于等于「人数 × 人均 × 天数」。
drop function if exists public.keyflow_admin_coin_scale_levels(text);

create or replace function public.keyflow_admin_coin_scale_levels(p_token text)
returns table(level int, people bigint, today_active_count bigint, month_active_count bigint, today_active_coins bigint, month_active_coins bigint)
language plpgsql
stable
security definer
set search_path = public
as $$
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
    select a.id,
           coalesce(ec.today_count, 0)::bigint as user_today_count,
           coalesce(ec.month_count, 0)::bigint as user_month_count,
           coalesce(rs.today_coins, 0)::bigint as user_today_coins,
           coalesce(rs.month_coins, 0)::bigint as user_month_coins,
           (
             coalesce(p.cnt, 0) * 50
             + coalesce(s.cnt, 0) * 300
             + coalesce(ds.cnt, 0) * 80
           )::bigint as user_points
    from public.keyflow_answerers a
    left join event_counts ec on ec.answerer_id = a.id
    left join reward_sums rs on rs.answerer_id = a.id
    left join (
      select answerer_id, count(distinct activity_id)::integer as cnt
      from public.keyflow_applications
      where status = 'selected'
      group by answerer_id
    ) p on p.answerer_id = a.id
    left join (
      select app.answerer_id, count(*)::integer as cnt
      from public.keyflow_applications app
      join public.keyflow_deliveries d on d.application_id = app.id
      group by app.answerer_id
    ) s on s.answerer_id = a.id
    left join (
      select answerer_id, count(*)::integer as cnt
      from public.keyflow_daily_submissions
      where answerer_id is not null
      group by answerer_id
    ) ds on ds.answerer_id = a.id
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
$$;

grant execute on function public.keyflow_admin_coin_scale_levels(text) to anon, authenticated;
