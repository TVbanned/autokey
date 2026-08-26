-- ============================================
-- 终极修复 keyflow_admin_create 函数歧义错误
-- 错误：Could not choose the best candidate function between
--       public.keyflow_admin_create(p_super_admin_id => text, ..., p_role => text, ...)
--   vs  public.keyflow_admin_create(p_super_admin_id => uuid, ..., p_role => text, ...)
--
-- 根因：
--   之前的迁移 recreate_all_admin_rpc_text_only.sql 只 DROP 了 5 参数版本，
--   但线上 DB 还残留着 add_admin_system_v2.sql 定义的 6 参数版本（含 p_password、p_role），
--   且 uuid 版和 text 版同时存在，前端调用时传了 6 个命名参数，PostgreSQL 无法区分。
--
-- 修复：
--   1. DROP 所有可能的旧签名（5/6 参数 × uuid/text 首参，共 4 种组合全部删干净
--   2. 重建 6 参数 text 版，与前端 App.jsx 的调用参数完全对齐
--   3. 重新授权
-- ============================================

-- ---------- 1) 彻底 DROP 所有 keyflow_admin_create 旧签名（所有可能的参数组合） ----------
-- 6 参数版（来自 add_admin_system_v2.sql 的原始签名，首参 uuid/text 两版都可能残留）
drop function if exists public.keyflow_admin_create(uuid, text, text, text, text, text[]) cascade;
drop function if exists public.keyflow_admin_create(text, text, text, text, text, text[]) cascade;
-- 5 参数版（来自 recreate_all_admin_rpc_text_only.sql 的简化签名，同样清干净以防万一）
drop function if exists public.keyflow_admin_create(uuid, text, text, text, text[]) cascade;
drop function if exists public.keyflow_admin_create(text, text, text, text, text[]) cascade;

-- ---------- 2) 重建 6 参数 text 版（与前端 App.jsx 第 4910-4917 行调用严格对齐） ----------
-- 前端调用参数：
--   p_super_admin_id  => adminSession.username (text，通过 resolve_admin_id 兼容 username/token/uuid)
--   p_username        => 新管理员用户名
--   p_password        => 初始密码（注意参数名是 p_password，不是 p_initial_password）
--   p_display_name    => 显示名
--   p_role            => 'admin' 或 'super_admin'
--   p_permissions     => text[] 权限数组
create or replace function public.keyflow_admin_create(
  p_super_admin_id text,
  p_username text,
  p_password text,
  p_display_name text,
  p_role text,
  p_permissions text[]
) returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_super uuid;
  v_new_id uuid;
begin
  -- 解析调用者身份：兼容 username、64 hex token、标准 uuid 三种格式
  v_super := resolve_admin_id(p_super_admin_id);
  if v_super is null then raise exception '登录状态已失效，请重新登录'; end if;

  -- 权限校验：必须是超级管理员
  if not exists (select 1 from keyflow_admin_users ku where ku.id = v_super and ku.role = 'super_admin') then
    raise exception '仅超级管理员可新建管理员账号';
  end if;

  -- 入参校验
  if length(trim(coalesce(p_username, ''))) < 2 then
    raise exception '用户名至少 2 位';
  end if;
  if exists (select 1 from keyflow_admin_users ku where ku.username = trim(p_username)) then
    raise exception '用户名已存在，请换一个';
  end if;
  if length(coalesce(p_password, '')) < 4 then
    raise exception '密码至少 4 位';
  end if;
  if trim(coalesce(p_display_name, '')) = '' then
    raise exception '显示名不能为空';
  end if;
  if coalesce(p_role, '') not in ('admin', 'super_admin') then
    raise exception '角色不合法';
  end if;

  -- 插入新管理员
  insert into keyflow_admin_users (username, password_hash, display_name, role, permissions)
  values (
    trim(p_username),
    crypt(p_password, gen_salt('bf')),
    trim(p_display_name),
    p_role,
    case
      when p_role = 'super_admin' then '{}'::text[]  -- 超级管理员权限由 role 决定，无需 perms 数组
      else coalesce(p_permissions, '{}'::text[])
    end
  )
  returning id into v_new_id;

  return v_new_id;
end;
$$;

-- ---------- 3) 重新授权 ----------
revoke all on function public.keyflow_admin_create(text, text, text, text, text, text[]) from public;
grant execute on function public.keyflow_admin_create(text, text, text, text, text, text[]) to anon, authenticated;
