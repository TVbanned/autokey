-- 修复：column "ku" of relation "keyflow_admin_users" does not exist
-- 根因：keyflow_admin_login 里的 UPDATE 语句写了 "set ku.session_token = v_token"，
--       PostgreSQL 语法规定 UPDATE 的 SET 子句中列名**绝对不能加表别名**，必须写裸列名。
--       WHERE 子句里才可以加表别名。

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

  -- 生成新风格 64hex token，并写入 session_token 列
  v_token := encode(hmac(v_admin.id::text || ':' || v_admin.username,
              'keyflow_admin_secret_' || extract(epoch from now())::int::text, 'sha256'), 'hex');

  -- ⚠️ UPDATE SET 中**列名绝不能加表别名**！这是 PostgreSQL 语法硬约束
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
