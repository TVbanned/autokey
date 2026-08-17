-- 答主管理走 RPC 收紧（完整落地版）
-- 说明：本文件字母序排在所有 migration 之后，覆盖 fix_admin_answerer_access.sql 的半成品定义。
-- 目标：前端不再直连 keyflow_answerers 表，全部改走受管理员 token 保护的 RPC。

-- 1) 管理员表增加会话 token 列
alter table public.keyflow_admin_users add column if not exists session_token uuid;

-- 2) 管理员登录：登录成功后生成/刷新 session_token 并返回
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
  v_token uuid;
begin
  select id, username, display_name, created_at
  into v_admin
  from keyflow_admin_users
  where username = p_username
    and password_hash = crypt(p_password, password_hash);

  if v_admin.id is null then
    raise exception '用户名或密码错误';
  end if;

  v_token := gen_random_uuid();
  update keyflow_admin_users set session_token = v_token where id = v_admin.id;

  return json_build_object(
    'id', v_admin.id,
    'username', v_admin.username,
    'display_name', v_admin.display_name,
    'created_at', v_admin.created_at,
    'session_token', v_token
  );
end;
$$;

grant execute on function public.keyflow_admin_login(text, text) to anon, authenticated;

-- 3) 管理员会话校验（仅内部使用，不对外开放）
create or replace function public.keyflow_is_admin(p_token uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1 from public.keyflow_admin_users
    where session_token = p_token and session_token is not null
  );
$$;

revoke all on function public.keyflow_is_admin(uuid) from public;

-- 4) 清除 fix_admin_answerer_access.sql 里的旧签名（无 token 版本）
drop function if exists public.keyflow_admin_answerer_summaries();
drop function if exists public.keyflow_admin_update_answerer_remark(uuid, text);
drop function if exists public.keyflow_admin_delete_answerer(uuid);

-- 5) 管理员 RPC：答主列表（含 wechat_id）
create or replace function public.keyflow_admin_answerer_summaries(p_token uuid)
returns table (
  id uuid,
  serial_number integer,
  zhihu_name text,
  account_address text,
  wechat_id text,
  avatar_url text,
  remark text,
  created_at timestamptz,
  updated_at timestamptz
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.keyflow_is_admin(p_token) then
    raise exception '管理员权限不足';
  end if;

  return query
  select
    a.id,
    a.serial_number,
    a.zhihu_name,
    a.account_address,
    a.wechat_id,
    a.avatar_url,
    a.remark,
    a.created_at,
    a.updated_at
  from public.keyflow_answerers a
  order by a.created_at desc;
end;
$$;

-- 6) 管理员 RPC：更新答主备注
create or replace function public.keyflow_admin_update_answerer_remark(
  p_token uuid,
  p_answerer_id uuid,
  p_remark text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.keyflow_is_admin(p_token) then
    raise exception '管理员权限不足';
  end if;

  update public.keyflow_answerers
  set remark = coalesce(p_remark, ''), updated_at = now()
  where id = p_answerer_id;
end;
$$;

-- 7) 管理员 RPC：删除答主
create or replace function public.keyflow_admin_delete_answerer(
  p_token uuid,
  p_answerer_id uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.keyflow_is_admin(p_token) then
    raise exception '管理员权限不足';
  end if;

  delete from public.keyflow_answerers where id = p_answerer_id;
end;
$$;

-- 8) 答主端 RPC：更新本人头像（与现有 keyflow_reset_password 等一致，security definer + 信任前端传入 id）
create or replace function public.keyflow_answerer_update_avatar(
  p_answerer_id uuid,
  p_avatar_url text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.keyflow_answerers
  set avatar_url = coalesce(p_avatar_url, ''), updated_at = now()
  where id = p_answerer_id;
end;
$$;

-- 9) 答主端 RPC：按知乎用户名查 id（忘记密码用）
create or replace function public.keyflow_answerer_id_by_zhihu_name(p_zhihu_name text)
returns uuid
language sql
security definer
stable
set search_path = public
as $$
  select id from public.keyflow_answerers
  where zhihu_name = p_zhihu_name
  order by created_at asc
  limit 1;
$$;

-- 10) 授权：前端为 anon 客户端，RPC 只授予 anon
revoke all on function public.keyflow_admin_answerer_summaries(uuid) from public;
revoke all on function public.keyflow_admin_update_answerer_remark(uuid, uuid, text) from public;
revoke all on function public.keyflow_admin_delete_answerer(uuid, uuid) from public;
revoke all on function public.keyflow_answerer_update_avatar(uuid, text) from public;
revoke all on function public.keyflow_answerer_id_by_zhihu_name(text) from public;

grant execute on function public.keyflow_admin_answerer_summaries(uuid) to anon;
grant execute on function public.keyflow_admin_update_answerer_remark(uuid, uuid, text) to anon;
grant execute on function public.keyflow_admin_delete_answerer(uuid, uuid) to anon;
grant execute on function public.keyflow_answerer_update_avatar(uuid, text) to anon;
grant execute on function public.keyflow_answerer_id_by_zhihu_name(text) to anon;

-- 11) 收紧：撤销 anon/authenticated 对答主表的直连权限，强制走 RPC
revoke select, insert, update, delete on table public.keyflow_answerers from anon, authenticated;
