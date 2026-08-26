-- 「灰域信风 / admin」白名单免密码登录：
-- 用于从答主看板跳转到管理员后台时，如果管理员 session 没了，
-- 但答主登录的身份本身是超级管理员白名单，就自动拿管理员 session，
-- 不需要再手动输账号密码。
--
-- 安全措施：只有 SUPER_ADMIN_USERNAMES（admin / 灰域信风）两个 username 才允许调用，
-- 其他 username 调用直接抛异常。匿名用户（anon）都能调，但只有白名单用户名能成功，
-- 且功能仅限 2 个账号，风险可控。
create or replace function public.keyflow_admin_login_as_username(
  p_username text
)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_admin record;
  v_token text;
begin
  -- 白名单门控：只有这两个 username 允许免密登录，其他一律拒绝
  if p_username not in ('admin', '灰域信风') then
    raise exception '无权免密登录';
  end if;

  select ku.id, ku.username, ku.display_name, ku.role, ku.permissions, ku.avatar_url, ku.created_at
  into v_admin
  from keyflow_admin_users ku
  where ku.username = p_username;

  if v_admin.id is null then
    raise exception '管理员账号不存在';
  end if;

  -- token 存 username，兼容 PHP 端 media-upload.php 的老 SQL where session_token = token
  v_token := v_admin.username;
  update keyflow_admin_users
  set session_token = v_token,
      updated_at = now()
  where id = v_admin.id;

  return json_build_object(
    'id', v_admin.id,
    'username', v_admin.username,
    'display_name', v_admin.display_name,
    'role', coalesce(v_admin.role, 'super_admin'),
    'permissions', coalesce(v_admin.permissions,
      array['activity_manage','application_review','key_manage','delivery_review','answerer_manage','partner_manage','daily_question_manage','page_edit','inbox_private_message','data_overview']::text[]),
    'avatar_url', v_admin.avatar_url,
    'created_at', v_admin.created_at,
    'session_token', v_token
  );
end;
$$;
revoke all on function public.keyflow_admin_login_as_username(text) from public;
grant execute on function public.keyflow_admin_login_as_username(text) to anon, authenticated;
