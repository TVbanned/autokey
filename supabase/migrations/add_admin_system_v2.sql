-- ============================================
-- 管理员系统 v2: 多管理员 + 角色权限 + 头像
-- ============================================

-- 重建管理员表（保留原有数据）
do $$
begin
  if not exists (select 1 from information_schema.columns where table_name = 'keyflow_admin_users' and column_name = 'role') then
    alter table public.keyflow_admin_users
      add column if not exists role text not null default 'admin',
      add column if not exists permissions text[] not null default '{}',
      add column if not exists avatar_url text,
      add column if not exists updated_at timestamptz not null default now();
  end if;
end $$;

-- 确保 username 唯一（如无约束则添加）
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'keyflow_admin_users_username_key') then
    alter table public.keyflow_admin_users add constraint keyflow_admin_users_username_key unique (username);
  end if;
end $$;

-- 升级现有默认管理员为超级管理员
update public.keyflow_admin_users
set role = 'super_admin',
    permissions = ARRAY['all']::text[]
where username = 'admin' and role = 'admin';

-- 如之前的硬编码账号 '灰域信风' 存在，也升级为超级管理员
insert into public.keyflow_admin_users (username, password_hash, display_name, role, permissions)
values ('灰域信风', crypt('admin123', gen_salt('bf')), '灰域信风', 'super_admin', ARRAY['all']::text[])
on conflict (username) do update set role = 'super_admin', permissions = ARRAY['all']::text[];

-- ---------- RPC: keyflow_admin_login_v2 ----------
-- 登录后返回完整管理员信息（含 role、permissions、avatar_url、session_token）
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
  select id, username, display_name, role, permissions, avatar_url, created_at
  into v_admin
  from keyflow_admin_users
  where username = p_username
    and password_hash = crypt(p_password, password_hash);

  if v_admin.id is null then
    raise exception '用户名或密码错误';
  end if;

  -- 生成一个简单的 token（直接由 id + username 组合签名，无需独立存储）
  v_token := encode(hmac(v_admin.id::text || ':' || v_admin.username, 'keyflow_admin_secret_' || extract(epoch from now())::int::text, 'sha256'), 'hex');

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

  update keyflow_admin_users
  set password_hash = crypt(p_new_password, gen_salt('bf')),
      updated_at = now()
  where id = p_admin_id
    and password_hash = crypt(p_old_password, password_hash)
  returning true into v_ok;

  if not found then
    raise exception '原密码错误';
  end if;

  return true;
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
  update keyflow_admin_users
  set avatar_url = p_avatar_url,
      updated_at = now()
  where id = p_admin_id
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

  update keyflow_admin_users
  set display_name = trim(p_display_name),
      updated_at = now()
  where id = p_admin_id;

  return found;
end;
$$;

grant execute on function public.keyflow_admin_update_display_name(uuid, text) to anon, authenticated;

-- ---------- RPC: keyflow_admin_list ----------
-- 仅超级管理员可调用
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
  select role = 'super_admin' into v_is_super
  from keyflow_admin_users where id = p_super_admin_id;

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
  select role = 'super_admin' into v_is_super
  from keyflow_admin_users where id = p_super_admin_id;

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
begin
  select role = 'super_admin' into v_is_super
  from keyflow_admin_users where id = p_super_admin_id;

  if not v_is_super then
    raise exception '无权限：仅超级管理员可修改管理员权限';
  end if;
  if p_role not in ('super_admin', 'admin') then
    raise exception '角色不合法';
  end if;

  -- 至少保留一个超级管理员
  if p_role = 'admin' then
    if (select count(*) from keyflow_admin_users where role = 'super_admin' and id <> p_target_admin_id) = 0 then
      raise exception '必须保留至少一个超级管理员';
    end if;
  end if;

  update keyflow_admin_users
  set role = p_role,
      permissions = coalesce(p_permissions, permissions),
      updated_at = now()
  where id = p_target_admin_id;

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
begin
  select role = 'super_admin' into v_is_super
  from keyflow_admin_users where id = p_super_admin_id;

  if not v_is_super then
    raise exception '无权限：仅超级管理员可删除管理员';
  end if;

  if p_super_admin_id = p_target_admin_id then
    raise exception '不能删除自己的账号';
  end if;

  select role = 'super_admin' into v_is_target_super
  from keyflow_admin_users where id = p_target_admin_id;

  if v_is_target_super then
    if (select count(*) from keyflow_admin_users where role = 'super_admin' and id <> p_target_admin_id) = 0 then
      raise exception '必须保留至少一个超级管理员';
    end if;
  end if;

  delete from keyflow_admin_users where id = p_target_admin_id;
  return found;
end;
$$;

grant execute on function public.keyflow_admin_delete(uuid, uuid) to anon, authenticated;

-- ---------- RPC: keyflow_admin_reset_password (super admin resets other admin) ----------
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
  select role = 'super_admin' into v_is_super
  from keyflow_admin_users where id = p_super_admin_id;

  if not v_is_super then
    raise exception '无权限：仅超级管理员可重置其他管理员密码';
  end if;
  if p_new_password is null or length(p_new_password) < 4 then
    raise exception '新密码至少 4 位';
  end if;

  update keyflow_admin_users
  set password_hash = crypt(p_new_password, gen_salt('bf')),
      updated_at = now()
  where id = p_target_admin_id;

  return found;
end;
$$;

grant execute on function public.keyflow_admin_reset_password(uuid, uuid, text) to anon, authenticated;
