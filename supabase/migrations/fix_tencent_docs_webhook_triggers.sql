-- 修复：改用 pg_net 扩展（net.http_post）替代托管版专属的 supabase_functions.http_request。
-- 作用不变：三张表 INSERT 时，自动调用 Edge Function sync-tencent-docs 同步到腾讯文档。

create extension if not exists pg_net with schema extensions;

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
      'type', 'INSERT',
      'table', TG_TABLE_NAME,
      'schema', TG_TABLE_SCHEMA,
      'record', to_jsonb(NEW),
      'old_record', null
    )
  );
  return NEW;
end;
$$;

-- 触发器保持不变（函数体已替换，无需重建触发器）
