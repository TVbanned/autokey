-- 记录“每条 Supabase 记录 -> 腾讯文档行号”的映射，用于 UPDATE 时原位更新状态列。
-- 由 Edge Function sync-tencent-docs 在成功写入 INSERT 后写入；UPDATE 时读取以定位行号。

create table if not exists public.keyflow_tencent_docs_rows (
  table_name text not null,
  record_id uuid not null,
  row integer not null,
  updated_at timestamptz not null default now(),
  primary key (table_name, record_id)
);

alter table public.keyflow_tencent_docs_rows enable row level security;
revoke all on table public.keyflow_tencent_docs_rows from anon, authenticated;

-- 触发器函数升级：同时支持 INSERT 与 UPDATE，UPDATE 时把 old_record 一并带给 Edge Function
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
  perform net.http_post(
    url := url,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'apikey', anon_key,
      'Authorization', 'Bearer ' || anon_key
    ),
    body := jsonb_build_object(
      'type', TG_OP,
      'table', TG_TABLE_NAME,
      'schema', TG_TABLE_SCHEMA,
      'record', to_jsonb(NEW),
      'old_record', case when TG_OP = 'UPDATE' then to_jsonb(OLD) else null end
    )
  );
  return NEW;
end;
$$;

-- 为三张表补 UPDATE 触发器（INSERT 触发器已存在，沿用同一函数）
drop trigger if exists trg_sync_tencent_daily_submissions_upd on public.keyflow_daily_submissions;
create trigger trg_sync_tencent_daily_submissions_upd
  after update on public.keyflow_daily_submissions
  for each row execute function public.sync_to_tencent_docs();

drop trigger if exists trg_sync_tencent_deliveries_upd on public.keyflow_deliveries;
create trigger trg_sync_tencent_deliveries_upd
  after update on public.keyflow_deliveries
  for each row execute function public.sync_to_tencent_docs();

drop trigger if exists trg_sync_tencent_daily_questions_upd on public.keyflow_daily_questions;
create trigger trg_sync_tencent_daily_questions_upd
  after update on public.keyflow_daily_questions
  for each row execute function public.sync_to_tencent_docs();
