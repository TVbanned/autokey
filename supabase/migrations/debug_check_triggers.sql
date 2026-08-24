-- 排查：列出三张表上的触发器及其绑定函数，确认 UPDATE 触发器是否存在。
select
  t.tgname as trigger_name,
  c.relname as table_name,
  p.proname as function_name,
  t.tgenabled as enabled
from pg_trigger t
join pg_class c on c.oid = t.tgrelid
join pg_proc p on p.oid = t.tgfoid
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relname in ('keyflow_daily_submissions','keyflow_deliveries','keyflow_daily_questions')
  and not t.tgisinternal
order by c.relname, t.tgname;
