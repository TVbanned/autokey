-- 修复 RPC 函数中 pgcrypto 的 search_path 问题
-- Supabase 中 pgcrypto 安装在 extensions schema，需要加入 search_path

-- 重新创建 keyflow_register_answerer，修复 crypt/gen_salt 引用
create or replace function public.keyflow_register_answerer(
  p_code text,
  p_zhihu_name text,
  p_account_address text,
  p_password text
)
returns json
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_code_id uuid;
  v_answerer_id uuid;
  v_answerer record;
begin
  select id into v_code_id
  from keyflow_invitation_codes
  where upper(code) = upper(p_code)
    and application_id is null
    and answerer_id is null
  for update skip locked;

  if v_code_id is null then
    raise exception '邀请码无效或已被使用';
  end if;

  insert into keyflow_answerers (invitation_code_id, zhihu_name, account_address, password_hash)
  values (v_code_id, p_zhihu_name, coalesce(p_account_address, ''), crypt(p_password, gen_salt('bf')))
  returning id into v_answerer_id;

  update keyflow_invitation_codes
  set answerer_id = v_answerer_id, used_at = now()
  where id = v_code_id;

  select id, zhihu_name, account_address, created_at
  into v_answerer
  from keyflow_answerers where id = v_answerer_id;

  return row_to_json(v_answerer);
end;
$$;

grant execute on function public.keyflow_register_answerer(text, text, text, text) to anon, authenticated;

-- 重新创建 keyflow_login_answerer
create or replace function public.keyflow_login_answerer(
  p_zhihu_name text,
  p_password text
)
returns json
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_answerer record;
begin
  select id, zhihu_name, account_address, created_at
  into v_answerer
  from keyflow_answerers
  where zhihu_name = p_zhihu_name
    and password_hash = crypt(p_password, password_hash);

  if v_answerer.id is null then
    raise exception '知乎用户名或密码错误';
  end if;

  return row_to_json(v_answerer);
end;
$$;

grant execute on function public.keyflow_login_answerer(text, text) to anon, authenticated;

-- 重新创建 keyflow_admin_login
create or replace function public.keyflow_admin_login(
  p_username text,
  p_password text
)
returns json
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_admin record;
begin
  select id, username, display_name, created_at
  into v_admin
  from keyflow_admin_users
  where username = p_username
    and password_hash = crypt(p_password, password_hash);

  if v_admin.id is null then
    raise exception '用户名或密码错误';
  end if;

  return row_to_json(v_admin);
end;
$$;

grant execute on function public.keyflow_admin_login(text, text) to anon, authenticated;
