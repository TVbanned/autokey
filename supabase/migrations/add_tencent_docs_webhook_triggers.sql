-- 用 Supabase 内置的 supabase_functions.http_request 触发器，给三张表挂 Database Webhook（等价于控制台的 Database Webhooks）。
-- 作用：当对应表发生 INSERT 时，自动 POST 到 Edge Function sync-tencent-docs，由它同步到腾讯文档。
-- 说明：
-- 1) 需要 pg_net 扩展（Supabase 默认已启用）。
-- 2) 表结构须与 Edge Function 期望一致：{ type, table, schema, record, old_record }。
-- 3) 这里直接调用 Edge Function 公网地址；依赖 Supabase 项目 ref 与 anon key。

-- 公共触发器函数：把当前行作为 INSERT 事件发给 sync-tencent-docs
create or replace function public.sync_to_tencent_docs()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  url text := 'https://ihbegkpvqrtycsfmklag.supabase.co/functions/v1/sync-tencent-docs';
  anon_key text := 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImloYmVna3B2cXJ0eWNzZm1rbGFnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQwOTkyODQsImV4cCI6MjA5OTY3NTI4NH0.6jmPv9_4S5zWzcmLo5tc2U4klU4tC4nZAeRcKrOrmVo';
begin
  perform supabase_functions.http_request(
    url,
    'POST',
    jsonb_build_object(
      'Content-Type', 'application/json',
      'apikey', anon_key,
      'Authorization', 'Bearer ' || anon_key
    ),
    jsonb_build_object(
      'type', 'INSERT',
      'table', TG_TABLE_NAME,
      'schema', TG_TABLE_SCHEMA,
      'record', to_jsonb(NEW),
      'old_record', null
    ),
    5000
  );
  return NEW;
end;
$$;

-- 三张表各挂一个 INSERT 触发器
drop trigger if exists trg_sync_tencent_daily_submissions on public.keyflow_daily_submissions;
create trigger trg_sync_tencent_daily_submissions
  after insert on public.keyflow_daily_submissions
  for each row execute function public.sync_to_tencent_docs();

drop trigger if exists trg_sync_tencent_deliveries on public.keyflow_deliveries;
create trigger trg_sync_tencent_deliveries
  after insert on public.keyflow_deliveries
  for each row execute function public.sync_to_tencent_docs();

drop trigger if exists trg_sync_tencent_daily_questions on public.keyflow_daily_questions;
create trigger trg_sync_tencent_daily_questions
  after insert on public.keyflow_daily_questions
  for each row execute function public.sync_to_tencent_docs();
