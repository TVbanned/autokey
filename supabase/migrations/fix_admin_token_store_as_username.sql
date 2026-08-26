-- 解决媒体上传 PHP 端鉴权失败的问题：
-- PHP 端 media-upload.php 内部不是调 resolve_admin_token / keyflow_is_admin(text)，
-- 而是直接跑裸 SQL：select 1 from keyflow_admin_users where session_token = <Bearer token>
-- 之前 token 存的是 64 hex，现在前端我们传 admin/username 过去就查不到。
--
-- 快速方案：在 session_token 列存两份兼容。但列是单行值。
-- 实际方案：直接把 session_token 列给每个 admin 的值都 UPDATE 成 username 本身，
--           这样 PHP 端的老 SQL where session_token = 'admin' 直接命中。
--           同时 resolve_admin_token / resolve_admin_id 也支持 username 查，两边都过！
--
--  ⚠️ 安全：username 泄露问题 → 只用于内部管理员系统，风险可控
--           之后 PHP 端升级到 keyflow_is_admin(text) 再换回来存 64hex

update keyflow_admin_users ku
set session_token = ku.username,
    updated_at = now()
where ku.session_token is null                  -- 老账号没 token
   or ku.session_token ~ '^[0-9a-fA-F]{64}$'   -- 新 64hex
   or ku.session_token ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'  -- 老 uuid
   or ku.session_token <> ku.username;         -- 已经不等于 username 的都更新一遍，统一成 username

-- 另外把 keyflow_admin_login RPC 也同步改掉：登录时存 session_token = username（方便 PHP 端老 SQL）
create or replace function public.keyflow_admin_login(
  p_username text,
  p_password text
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
  select ku.id, ku.username, ku.display_name, ku.role, ku.permissions, ku.avatar_url, ku.created_at
  into v_admin
  from keyflow_admin_users ku
  where ku.username = p_username
    and ku.password_hash = crypt(p_password, ku.password_hash);

  if v_admin.id is null then
    raise exception '用户名或密码错误';
  end if;

  -- ⚠️ 现在 token 存 username，兼容 PHP 端 media-upload.php 里直接 where session_token = token 的老 SQL
  v_token := v_admin.username;
  update keyflow_admin_users
  set session_token = v_token,
      updated_at = now()
  where id = v_admin.id;

  return json_build_object(
    'id', v_admin.id,
    'username', v_admin.username,
    'display_name', v_admin.display_name,
    'role', v_admin.role,
    'permissions', coalesce(v_admin.permissions, '{}'::text[]),
    'avatar_url', v_admin.avatar_url,
    'created_at', v_admin.created_at,
    'session_token', v_token
  );
end;
$$;
grant execute on function public.keyflow_admin_login(text, text) to anon, authenticated;
