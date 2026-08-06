-- 确保管理员登录 RPC 正确配置（search_path 包含 extensions 以使用 crypt()）
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
