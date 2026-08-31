-- 统一腾讯文档同步 webhook：INSERT/UPDATE 都发送完整事件，避免后续迁移覆盖掉 UPDATE 支持。
create extension if not exists pg_net with schema extensions;

create or replace function public.sync_to_tencent_docs()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_url text := 'https://ihbegkpvqrtycsfmklag.supabase.co/functions/v1/sync-tencent-docs';
  v_anon_key text := 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImloYmVna3B2cXJ0eWNzZm1rbGFnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQwOTkyODQsImV4cCI6MjA5OTY3NTI4NH0.6jmPv9_4S5zWzcmLo5tc2U4klU4tC4nZAeRcKrOrmVo';
begin

  perform net.http_post(
    url := v_url,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'apikey', v_anon_key,
      'Authorization', 'Bearer ' || v_anon_key
    ),
    body := jsonb_build_object(
      'type', TG_OP,
      'table', TG_TABLE_NAME,
      'schema', TG_TABLE_SCHEMA,
      'record', to_jsonb(NEW),
      'old_record', case when TG_OP = 'UPDATE' then to_jsonb(OLD) else null end
    )
  );
  return new;
end;
$$;

-- 重新创建触发器，确保 INSERT 和 UPDATE 都使用同一个最终函数。
drop trigger if exists trg_sync_tencent_daily_submissions on public.keyflow_daily_submissions;
create trigger trg_sync_tencent_daily_submissions
after insert on public.keyflow_daily_submissions
for each row execute function public.sync_to_tencent_docs();

drop trigger if exists trg_sync_tencent_daily_submissions_upd on public.keyflow_daily_submissions;
create trigger trg_sync_tencent_daily_submissions_upd
after update on public.keyflow_daily_submissions
for each row execute function public.sync_to_tencent_docs();

drop trigger if exists trg_sync_tencent_deliveries on public.keyflow_deliveries;
create trigger trg_sync_tencent_deliveries
after insert on public.keyflow_deliveries
for each row execute function public.sync_to_tencent_docs();

drop trigger if exists trg_sync_tencent_deliveries_upd on public.keyflow_deliveries;
create trigger trg_sync_tencent_deliveries_upd
after update on public.keyflow_deliveries
for each row execute function public.sync_to_tencent_docs();

drop trigger if exists trg_sync_tencent_daily_questions on public.keyflow_daily_questions;
create trigger trg_sync_tencent_daily_questions
after insert on public.keyflow_daily_questions
for each row execute function public.sync_to_tencent_docs();

drop trigger if exists trg_sync_tencent_daily_questions_upd on public.keyflow_daily_questions;
create trigger trg_sync_tencent_daily_questions_upd
after update on public.keyflow_daily_questions
for each row execute function public.sync_to_tencent_docs();
