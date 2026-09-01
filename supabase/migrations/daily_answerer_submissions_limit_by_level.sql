-- 答主看板「今日创作/提问投稿」：回答投稿每日限额按个人积分等级计算。
-- Lv1 每天 1 条、Lv2 每天 2 条……Lv10 每天 10 条（1 级起每级 +1）。
-- 数据库层强制：同一答主当天（Asia/Shanghai）最多可投与等级相同的条数。
-- 管理员粘贴录入的条目 answerer_id 为 NULL，不受此限制影响。

create or replace function public.keyflow_enforce_daily_submission_limit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_points integer;
  v_limit integer;
  v_today_count integer;
begin
  if new.answerer_id is null then
    return new;
  end if;

  perform pg_advisory_xact_lock(hashtext(new.answerer_id::text));

  select
    coalesce(
      (select count(distinct activity_id) * 50 from keyflow_applications where answerer_id = new.answerer_id and status = 'selected') +
      (select count(*) * 300 from keyflow_applications a join keyflow_deliveries d on d.application_id = a.id where a.answerer_id = new.answerer_id) +
      (select count(*) * 80 from keyflow_daily_submissions where answerer_id = new.answerer_id),
      0
    )
  into v_points;

  v_limit := case
    when v_points >= 15000 then 10 when v_points >= 11000 then 9 when v_points >= 8000 then 8
    when v_points >= 5500 then 7 when v_points >= 3500 then 6 when v_points >= 2000 then 5
    when v_points >= 1000 then 4 when v_points >= 500 then 3 when v_points >= 200 then 2 else 1
  end;

  select count(*) into v_today_count
  from public.keyflow_daily_submissions
  where answerer_id = new.answerer_id
    and (created_at at time zone 'Asia/Shanghai') >= date_trunc('day', (now() at time zone 'Asia/Shanghai'));

  if v_today_count >= v_limit then
    raise exception '今日已回答投稿已达上限（Lv% 每天限投 % 条回答）', v_limit, v_limit;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_enforce_daily_submission_limit on public.keyflow_daily_submissions;
create trigger trg_enforce_daily_submission_limit
  before insert on public.keyflow_daily_submissions
  for each row
  execute function public.keyflow_enforce_daily_submission_limit();
