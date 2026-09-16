-- 腾讯文档同步 webhook 超时调大：日常投稿表已到 800+ 行，全量重排写一次要 5s 上下，
-- pg_net 默认 5000ms 会记成 Timeout（函数其实还在后台跑完），日志噪音会掩盖真实故障。
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
    ),
    timeout_milliseconds := 30000
  );
  return new;
end;
$$;
