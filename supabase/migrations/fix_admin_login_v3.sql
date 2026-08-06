-- 最简方案：RPC 内硬编码账号验证，不依赖表、不依赖哈希函数
create or replace function public.keyflow_admin_login(
  p_username text,
  p_password text
)
returns json
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_username = 'admin' and p_password = 'admin123' then
    return json_build_object(
      'id', '00000000-0000-0000-0000-000000000000',
      'username', 'admin',
      'display_name', '管理员',
      'created_at', now()
    );
  end if;
  raise exception '用户名或密码错误';
end;
$$;

grant execute on function public.keyflow_admin_login(text, text) to anon, authenticated;
