-- ============================================
-- 启用 pgcrypto 扩展（crypt / gen_salt / hmac 函数来源）
-- 解决: function crypt(text, text) does not exist
-- ============================================

create extension if not exists pgcrypto;

-- 兼容：有些 Supabase 实例 pgcrypto 放在 extensions schema，
-- 确保 public.search_path 能找到；或者显式 public 化 crypt/gen_salt/hmac
do $$
declare
  v_schema text;
begin
  -- 查找 pgcrypto 实际所在的 schema
  select n.nspname into v_schema
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where p.proname = 'crypt'
    and array_length(p.proargtypes, 1) = 2
    and p.pronargs = 2
  limit 1;

  if v_schema is not null and v_schema <> 'public' then
    -- 函数在非 public schema，通过 search_path 让 SECURITY DEFINER 函数可见
    -- 同时把 3 个关键函数别名到 public
    execute 'create or replace function public.crypt(text, text) returns text as $X$ select ' || quote_ident(v_schema) || '.crypt($1,$2); $X$ language sql immutable strict';
    execute 'create or replace function public.gen_salt(text) returns text as $X$ select ' || quote_ident(v_schema) || '.gen_salt($1); $X$ language sql volatile strict';
    execute 'create or replace function public.hmac(text, text, text) returns bytea as $X$ select ' || quote_ident(v_schema) || '.hmac($1::bytea,$2::bytea,$3); $X$ language sql immutable strict';
  end if;
end $$;
