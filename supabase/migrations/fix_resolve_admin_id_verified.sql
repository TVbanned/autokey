-- 修复上传头像时「登录状态已失效」：resolve_admin_id / resolve_admin_token 逻辑完全重写，
-- 所有分支最终都要查 keyflow_admin_users 表，确保管理员存在、不是伪 UUID
--
-- 传进来的 p_input 实际来源有 2 种：
--   (1) 管理员系统管理类 RPC（update_avatar / change_password 等）
--       → 前端传 adminSession.id（真实DB UUID 或 旧 session 伪 UUID）
--   (2) 管理员数据加载类 RPC（daily_questions / answerer_summaries 等）
--       → 前端传 getAdminToken() = 64 hex session_token
--
-- 所以 resolve_admin_id 必须同时兼容 3 种输入，并且**都要去表里验证真实存在**，
-- 伪 UUID（00000000-0000-0000-0000-00000000000[01]）必须返回 null 触发重登。

create or replace function public.resolve_admin_id(p_input text)
returns uuid
language plpgsql
set search_path = public
as $$
declare
  v_id uuid;
  v_verified uuid;
begin
  if p_input is null or trim(p_input) = '' then return null; end if;

  -- --------------------------------------------------------------
  -- 分支 A：标准 UUID 格式（真实 DB id 或 旧 session 伪 UUID）
  -- --------------------------------------------------------------
  if p_input ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then
    -- A1：伪 UUID（旧 session 生成的 00000000...0000/0001）→ 一律返回 null，触发 SESSION_UPGRADE_REQUIRED 重登
    if p_input ~ '^00000000-0000-0000-0000-00000000000[01]$' then
      return null;
    end if;
    -- A2：转成 uuid 后**直接去表里验证**（必须真实存在于 keyflow_admin_users.id）
    begin
      v_id := p_input::uuid;
      select ku.id into v_verified
      from keyflow_admin_users ku
      where ku.id = v_id
      limit 1;
      return v_verified;   -- null / 真实存在的 id
    exception when others then
      return null;
    end;
  end if;

  -- --------------------------------------------------------------
  -- 分支 B：64 hex（session_token，SHA256 HMAC → 64 chars）
  -- --------------------------------------------------------------
  if p_input ~ '^[0-9a-fA-F]{64}$' then
    select ku.id into v_verified
    from keyflow_admin_users ku
    where ku.session_token = p_input
      and ku.session_token is not null
    limit 1;
    if v_verified is not null then return v_verified; end if;
    -- 兜底：64 hex 但当 session_token 查不到 → 可能是没重新登录，返回 null 触发前端清 session
    return null;
  end if;

  -- --------------------------------------------------------------
  -- 分支 C：其他字符串 → 当 username 查（调试 / 兼容）
  -- --------------------------------------------------------------
  select ku.id into v_verified
  from keyflow_admin_users ku
  where ku.username = p_input
  limit 1;
  return v_verified;
end;
$$;

-- resolve_admin_token 是管理员数据加载类用的，也是同样逻辑，直接改成 alias resolve_admin_id 的行为
create or replace function public.resolve_admin_token(p_input text)
returns uuid
language plpgsql
set search_path = public
as $$
declare
  v_id uuid;
  v_verified uuid;
begin
  if p_input is null or trim(p_input) = '' then return null; end if;

  -- 优先按 session_token 查（因为 resolve_admin_token 专门是鉴权 token 用的）
  select ku.id into v_verified
  from keyflow_admin_users ku
  where ku.session_token = p_input
    and ku.session_token is not null
  limit 1;
  if v_verified is not null then return v_verified; end if;

  -- 兜底再走通用 resolve_admin_id（伪 UUID / username / 真实 UUID）
  return public.resolve_admin_id(p_input);
end;
$$;
