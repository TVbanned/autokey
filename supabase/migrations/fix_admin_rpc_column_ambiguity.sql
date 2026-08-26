-- ============================================
-- 修复：column reference "role" is ambiguous
-- 根因：keyflow_admin_list 使用 RETURNS TABLE，其输出列 (role, permissions, id, username, ...)
--       与表 keyflow_admin_users 的列同名。所有 RPC 内部 SQL 必须显式加表前缀。
-- ============================================

-- ---------- RPC: keyflow_admin_login ----------
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

  v_token := encode(hmac(v_admin.id::text || ':' || v_admin.username,
              'keyflow_admin_secret_' || extract(epoch from now())::int::text, 'sha256'), 'hex');

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

-- ---------- RPC: keyflow_admin_change_password ----------
create or replace function public.keyflow_admin_change_password(
  p_admin_id uuid,
  p_old_password text,
  p_new_password text
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ok boolean;
begin
  if p_new_password is null or length(p_new_password) < 4 then
    raise exception '新密码至少 4 位';
  end if;

  update keyflow_admin_users ku
  set ku.password_hash = crypt(p_new_password, gen_salt('bf')),
      ku.updated_at = now()
  where ku.id = p_admin_id
    and ku.password_hash = crypt(p_old_password, ku.password_hash)
  returning true into v_ok;

  return found;
end;
$$;

grant execute on function public.keyflow_admin_change_password(uuid, text, text) to anon, authenticated;

-- ---------- RPC: keyflow_admin_update_avatar ----------
create or replace function public.keyflow_admin_update_avatar(
  p_admin_id uuid,
  p_avatar_url text
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ok boolean;
begin
  update keyflow_admin_users ku
  set ku.avatar_url = p_avatar_url,
      ku.updated_at = now()
  where ku.id = p_admin_id
  returning true into v_ok;

  return found;
end;
$$;

grant execute on function public.keyflow_admin_update_avatar(uuid, text) to anon, authenticated;

-- ---------- RPC: keyflow_admin_update_display_name ----------
create or replace function public.keyflow_admin_update_display_name(
  p_admin_id uuid,
  p_display_name text
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_display_name is null or length(trim(p_display_name)) = 0 then
    raise exception '显示名不能为空';
  end if;

  update keyflow_admin_users ku
  set ku.display_name = trim(p_display_name),
      ku.updated_at = now()
  where ku.id = p_admin_id;

  return found;
end;
$$;

grant execute on function public.keyflow_admin_update_display_name(uuid, text) to anon, authenticated;

-- ---------- RPC: keyflow_admin_list ----------
create or replace function public.keyflow_admin_list(
  p_super_admin_id uuid
)
returns table (
  id uuid,
  username text,
  display_name text,
  role text,
  permissions text[],
  avatar_url text,
  created_at timestamptz,
  updated_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_is_super boolean;
begin
  select (ku.role = 'super_admin') into v_is_super
  from keyflow_admin_users ku where ku.id = p_super_admin_id;

  if not v_is_super then
    raise exception '无权限：仅超级管理员可查看管理员列表';
  end if;

  return query
  select a.id, a.username, a.display_name, a.role,
         coalesce(a.permissions, '{}'::text[]), a.avatar_url,
         a.created_at, a.updated_at
  from keyflow_admin_users a
  order by a.created_at desc;
end;
$$;

grant execute on function public.keyflow_admin_list(uuid) to anon, authenticated;

-- ---------- RPC: keyflow_admin_create ----------
create or replace function public.keyflow_admin_create(
  p_super_admin_id uuid,
  p_username text,
  p_password text,
  p_display_name text,
  p_role text default 'admin',
  p_permissions text[] default '{}'
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_is_super boolean;
  v_new_id uuid;
begin
  select (ku.role = 'super_admin') into v_is_super
  from keyflow_admin_users ku where ku.id = p_super_admin_id;

  if not v_is_super then
    raise exception '无权限：仅超级管理员可新建管理员';
  end if;

  if p_username is null or length(trim(p_username)) < 2 then
    raise exception '用户名至少 2 位';
  end if;
  if p_password is null or length(p_password) < 4 then
    raise exception '密码至少 4 位';
  end if;
  if p_display_name is null or length(trim(p_display_name)) = 0 then
    raise exception '显示名不能为空';
  end if;
  if p_role not in ('super_admin', 'admin') then
    raise exception '角色不合法';
  end if;

  insert into keyflow_admin_users (username, password_hash, display_name, role, permissions)
  values (trim(p_username), crypt(p_password, gen_salt('bf')), trim(p_display_name), p_role, coalesce(p_permissions, '{}'::text[]))
  returning id into v_new_id;

  return v_new_id;
end;
$$;

grant execute on function public.keyflow_admin_create(uuid, text, text, text, text, text[]) to anon, authenticated;

-- ---------- RPC: keyflow_admin_update_role ----------
create or replace function public.keyflow_admin_update_role(
  p_super_admin_id uuid,
  p_target_admin_id uuid,
  p_role text,
  p_permissions text[] default '{}'
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_is_super boolean;
  v_super_count int;
begin
  select (ku.role = 'super_admin') into v_is_super
  from keyflow_admin_users ku where ku.id = p_super_admin_id;

  if not v_is_super then
    raise exception '无权限：仅超级管理员可修改管理员权限';
  end if;
  if p_role not in ('super_admin', 'admin') then
    raise exception '角色不合法';
  end if;

  -- 至少保留一个超级管理员
  if p_role = 'admin' then
    select count(*) into v_super_count
    from keyflow_admin_users ku
    where ku.role = 'super_admin' and ku.id <> p_target_admin_id;
    if v_super_count = 0 then
      raise exception '必须保留至少一个超级管理员';
    end if;
  end if;

  update keyflow_admin_users ku
  set ku.role = p_role,
      ku.permissions = coalesce(p_permissions, ku.permissions),
      ku.updated_at = now()
  where ku.id = p_target_admin_id;

  return found;
end;
$$;

grant execute on function public.keyflow_admin_update_role(uuid, uuid, text, text[]) to anon, authenticated;

-- ---------- RPC: keyflow_admin_delete ----------
create or replace function public.keyflow_admin_delete(
  p_super_admin_id uuid,
  p_target_admin_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_is_super boolean;
  v_is_target_super boolean;
  v_super_count int;
begin
  select (ku.role = 'super_admin') into v_is_super
  from keyflow_admin_users ku where ku.id = p_super_admin_id;

  if not v_is_super then
    raise exception '无权限：仅超级管理员可删除管理员';
  end if;

  if p_super_admin_id = p_target_admin_id then
    raise exception '不能删除自己的账号';
  end if;

  select (ku.role = 'super_admin') into v_is_target_super
  from keyflow_admin_users ku where ku.id = p_target_admin_id;

  if v_is_target_super then
    select count(*) into v_super_count
    from keyflow_admin_users ku
    where ku.role = 'super_admin' and ku.id <> p_target_admin_id;
    if v_super_count = 0 then
      raise exception '必须保留至少一个超级管理员';
    end if;
  end if;

  delete from keyflow_admin_users ku where ku.id = p_target_admin_id;
  return found;
end;
$$;

grant execute on function public.keyflow_admin_delete(uuid, uuid) to anon, authenticated;

-- ---------- RPC: keyflow_admin_reset_password ----------
create or replace function public.keyflow_admin_reset_password(
  p_super_admin_id uuid,
  p_target_admin_id uuid,
  p_new_password text
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_is_super boolean;
begin
  select (ku.role = 'super_admin') into v_is_super
  from keyflow_admin_users ku where ku.id = p_super_admin_id;

  if not v_is_super then
    raise exception '无权限：仅超级管理员可重置其他管理员密码';
  end if;
  if p_new_password is null or length(p_new_password) < 4 then
    raise exception '新密码至少 4 位';
  end if;

  update keyflow_admin_users ku
  set ku.password_hash = crypt(p_new_password, gen_salt('bf')),
      ku.updated_at = now()
  where ku.id = p_target_admin_id;

  return found;
end;
$$;

grant execute on function public.keyflow_admin_reset_password(uuid, uuid, text) to anon, authenticated;
