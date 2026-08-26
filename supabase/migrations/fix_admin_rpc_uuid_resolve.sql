-- ============================================
-- 修复：invalid input syntax for type uuid: "64hex..."
-- 根因：前端传的 id 参数可能是：
--   1) 标准 UUID（36 chars，来自 keyflow_admin_users.id）
--   2) 64 hex chars（SHA256 HMAC session_token，来自新login返回）
--   3) 伪 UUID（00000000-0000-0000-0000-000000000000，旧硬编码RPC）
--
-- 方案：所有 RPC 将 p_super_admin_id / p_admin_id / p_target_admin_id
--       从 uuid 改为 text 接收，内部用 resolve_admin_id(text) 统一解析。
-- ============================================

-- ---------- helper: resolve_admin_id(text) -> uuid ----------
-- 支持三种输入：UUID（直接返回）、64 hex（当session_token查）、其他（当username查）
create or replace function public.resolve_admin_id(p_input text)
returns uuid
language plpgsql
set search_path = public
as $$
declare
  v_id uuid;
begin
  if p_input is null then return null; end if;

  -- 1) 标准 UUID 格式（36 chars with dashes 或 32 chars without dashes）
  if p_input ~ '^[0-9a-fA-F]{8}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{12}$' then
    begin
      return p_input::uuid;
    exception when others then null;
    end;
  end if;

  -- 2) 64 hex chars：当作 session_token（旧 session_token 列是 uuid，但新返回是 64hex，
  --    我们兼容在 keyflow_admin_users 中查找 session_token::uuid，或者兜底按 id 查是否存过 64hex）
  if length(p_input) = 64 and p_input ~ '^[0-9a-fA-F]+$' then
    -- 64 hex 按 session_token 查不了（表列 session_token 是 uuid），兜底：查 username 对应不到就返回 null
    -- 实际：这种情况说明前端把 session_token 当 id 传了，此时应该由前端 SESSION_UPGRADE_REQUIRED 门控强制重登。
    -- 这里返回 null 让 RPC 后续抛「无权限」错误而非崩溃。
    return null;
  end if;

  -- 3) 兜底：作为 username 查找
  select ku.id into v_id
  from keyflow_admin_users ku
  where ku.username = p_input
  limit 1;

  return v_id;
end;
$$;

-- ---------- RPC: keyflow_admin_login（登录本身参数是 text，无需改签名，直接保持最新版） ----------
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
  p_admin_id text,
  p_old_password text,
  p_new_password text
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_admin_id uuid;
  v_ok boolean;
begin
  v_admin_id := resolve_admin_id(p_admin_id);
  if v_admin_id is null then raise exception '管理员不存在'; end if;

  if p_new_password is null or length(p_new_password) < 4 then
    raise exception '新密码至少 4 位';
  end if;

  update keyflow_admin_users ku
  set ku.password_hash = crypt(p_new_password, gen_salt('bf')),
      ku.updated_at = now()
  where ku.id = v_admin_id
    and ku.password_hash = crypt(p_old_password, ku.password_hash)
  returning true into v_ok;

  return found;
end;
$$;
grant execute on function public.keyflow_admin_change_password(text, text, text) to anon, authenticated;

-- ---------- RPC: keyflow_admin_update_avatar ----------
create or replace function public.keyflow_admin_update_avatar(
  p_admin_id text,
  p_avatar_url text
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_admin_id uuid;
  v_ok boolean;
begin
  v_admin_id := resolve_admin_id(p_admin_id);
  if v_admin_id is null then raise exception '管理员不存在'; end if;

  update keyflow_admin_users ku
  set ku.avatar_url = p_avatar_url,
      ku.updated_at = now()
  where ku.id = v_admin_id
  returning true into v_ok;

  return found;
end;
$$;
grant execute on function public.keyflow_admin_update_avatar(text, text) to anon, authenticated;

-- ---------- RPC: keyflow_admin_update_display_name ----------
create or replace function public.keyflow_admin_update_display_name(
  p_admin_id text,
  p_display_name text
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_admin_id uuid;
begin
  v_admin_id := resolve_admin_id(p_admin_id);
  if v_admin_id is null then raise exception '管理员不存在'; end if;

  if p_display_name is null or length(trim(p_display_name)) = 0 then
    raise exception '显示名不能为空';
  end if;

  update keyflow_admin_users ku
  set ku.display_name = trim(p_display_name),
      ku.updated_at = now()
  where ku.id = v_admin_id;

  return found;
end;
$$;
grant execute on function public.keyflow_admin_update_display_name(text, text) to anon, authenticated;

-- ---------- RPC: keyflow_admin_list ----------
create or replace function public.keyflow_admin_list(
  p_super_admin_id text
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
  v_super_id uuid;
  v_is_super boolean;
begin
  v_super_id := resolve_admin_id(p_super_admin_id);
  if v_super_id is null then raise exception '无权限：仅超级管理员可查看管理员列表'; end if;

  select (ku.role = 'super_admin') into v_is_super
  from keyflow_admin_users ku where ku.id = v_super_id;

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
grant execute on function public.keyflow_admin_list(text) to anon, authenticated;

-- ---------- RPC: keyflow_admin_create ----------
create or replace function public.keyflow_admin_create(
  p_super_admin_id text,
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
  v_super_id uuid;
  v_is_super boolean;
  v_new_id uuid;
begin
  v_super_id := resolve_admin_id(p_super_admin_id);
  if v_super_id is null then raise exception '无权限：仅超级管理员可新建管理员'; end if;

  select (ku.role = 'super_admin') into v_is_super
  from keyflow_admin_users ku where ku.id = v_super_id;

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
grant execute on function public.keyflow_admin_create(text, text, text, text, text, text[]) to anon, authenticated;

-- ---------- RPC: keyflow_admin_update_role ----------
create or replace function public.keyflow_admin_update_role(
  p_super_admin_id text,
  p_target_admin_id text,
  p_role text,
  p_permissions text[] default '{}'
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_super_id uuid;
  v_target_id uuid;
  v_is_super boolean;
  v_super_count int;
begin
  v_super_id := resolve_admin_id(p_super_admin_id);
  v_target_id := resolve_admin_id(p_target_admin_id);
  if v_super_id is null or v_target_id is null then raise exception '管理员不存在'; end if;

  select (ku.role = 'super_admin') into v_is_super
  from keyflow_admin_users ku where ku.id = v_super_id;

  if not v_is_super then
    raise exception '无权限：仅超级管理员可修改管理员权限';
  end if;
  if p_role not in ('super_admin', 'admin') then
    raise exception '角色不合法';
  end if;

  if p_role = 'admin' then
    select count(*) into v_super_count
    from keyflow_admin_users ku
    where ku.role = 'super_admin' and ku.id <> v_target_id;
    if v_super_count = 0 then
      raise exception '必须保留至少一个超级管理员';
    end if;
  end if;

  update keyflow_admin_users ku
  set ku.role = p_role,
      ku.permissions = coalesce(p_permissions, ku.permissions),
      ku.updated_at = now()
  where ku.id = v_target_id;

  return found;
end;
$$;
grant execute on function public.keyflow_admin_update_role(text, text, text, text[]) to anon, authenticated;

-- ---------- RPC: keyflow_admin_delete ----------
create or replace function public.keyflow_admin_delete(
  p_super_admin_id text,
  p_target_admin_id text
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_super_id uuid;
  v_target_id uuid;
  v_is_super boolean;
  v_is_target_super boolean;
  v_super_count int;
begin
  v_super_id := resolve_admin_id(p_super_admin_id);
  v_target_id := resolve_admin_id(p_target_admin_id);
  if v_super_id is null or v_target_id is null then raise exception '管理员不存在'; end if;

  select (ku.role = 'super_admin') into v_is_super
  from keyflow_admin_users ku where ku.id = v_super_id;

  if not v_is_super then
    raise exception '无权限：仅超级管理员可删除管理员';
  end if;

  if v_super_id = v_target_id then
    raise exception '不能删除自己的账号';
  end if;

  select (ku.role = 'super_admin') into v_is_target_super
  from keyflow_admin_users ku where ku.id = v_target_id;

  if v_is_target_super then
    select count(*) into v_super_count
    from keyflow_admin_users ku
    where ku.role = 'super_admin' and ku.id <> v_target_id;
    if v_super_count = 0 then
      raise exception '必须保留至少一个超级管理员';
    end if;
  end if;

  delete from keyflow_admin_users ku where ku.id = v_target_id;
  return found;
end;
$$;
grant execute on function public.keyflow_admin_delete(text, text) to anon, authenticated;

-- ---------- RPC: keyflow_admin_reset_password ----------
create or replace function public.keyflow_admin_reset_password(
  p_super_admin_id text,
  p_target_admin_id text,
  p_new_password text
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_super_id uuid;
  v_target_id uuid;
  v_is_super boolean;
begin
  v_super_id := resolve_admin_id(p_super_admin_id);
  v_target_id := resolve_admin_id(p_target_admin_id);
  if v_super_id is null or v_target_id is null then raise exception '管理员不存在'; end if;

  select (ku.role = 'super_admin') into v_is_super
  from keyflow_admin_users ku where ku.id = v_super_id;

  if not v_is_super then
    raise exception '无权限：仅超级管理员可重置其他管理员密码';
  end if;
  if p_new_password is null or length(p_new_password) < 4 then
    raise exception '新密码至少 4 位';
  end if;

  update keyflow_admin_users ku
  set ku.password_hash = crypt(p_new_password, gen_salt('bf')),
      ku.updated_at = now()
  where ku.id = v_target_id;

  return found;
end;
$$;
grant execute on function public.keyflow_admin_reset_password(text, text, text) to anon, authenticated;
