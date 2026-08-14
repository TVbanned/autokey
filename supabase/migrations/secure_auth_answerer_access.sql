-- Auth 身份迁移：新的答主必须通过 Supabase Auth 绑定业务档案。
-- 旧 keyflow_login_answerer 仅由受控 answerer-auth-bootstrap 用于验证存量业务密码并建立 Auth 映射。
-- 旧 keyflow_register_answerer 不得供客户端调用；所有新注册必须经 answerer-auth-bootstrap 和 keyflow_register_answerer_for_auth。
-- 两者的返回值或 localStorage 均不得作为授权依据，授权始终以 Supabase Auth 会话与映射为准。

alter table public.keyflow_answerers enable row level security;

drop policy if exists "keyflow answerers no client access" on public.keyflow_answerers;
drop policy if exists "keyflow answerer self select" on public.keyflow_answerers;
drop policy if exists "keyflow answerer self update" on public.keyflow_answerers;

create policy "keyflow answerer self select"
  on public.keyflow_answerers
  for select to authenticated
  using (auth_user_id = auth.uid());

create policy "keyflow answerer self update"
  on public.keyflow_answerers
  for update to authenticated
  using (auth_user_id = auth.uid())
  with check (auth_user_id = auth.uid());

revoke all on table public.keyflow_answerers from anon, authenticated;
grant select, update on table public.keyflow_answerers to authenticated;

create or replace function public.keyflow_my_answerer_profile()
returns table (
  id uuid,
  serial_number integer,
  zhihu_name text,
  account_address text,
  avatar_url text,
  remark text,
  created_at timestamptz,
  updated_at timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select
    a.id,
    a.serial_number,
    a.zhihu_name,
    a.account_address,
    a.avatar_url,
    a.remark,
    a.created_at,
    a.updated_at
  from public.keyflow_answerers a
  where a.auth_user_id = auth.uid()
$$;

create or replace function public.keyflow_admin_answerer_summaries()
returns table (
  id uuid,
  serial_number integer,
  zhihu_name text,
  account_address text,
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
  if not public.keyflow_is_admin() then
    raise exception '管理员权限不足';
  end if;

  return query
  select
    a.id,
    a.serial_number,
    a.zhihu_name,
    a.account_address,
    a.avatar_url,
    a.remark,
    a.created_at,
    a.updated_at
  from public.keyflow_answerers a
  order by a.created_at desc;
end;
$$;

create or replace function public.keyflow_create_my_answerer(
  p_code text,
  p_zhihu_name text,
  p_account_address text,
  p_wechat_id text
)
returns table (
  id uuid,
  serial_number integer,
  zhihu_name text,
  account_address text,
  avatar_url text,
  created_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_code_id uuid;
  v_answerer_id uuid;
begin
  if auth.uid() is null then
    raise exception '需要登录后才能创建答主资料';
  end if;
  if exists (select 1 from public.keyflow_answerers where auth_user_id = auth.uid()) then
    raise exception '该 Auth 账号已绑定答主资料';
  end if;

  select ic.id into v_code_id
  from public.keyflow_invitation_codes ic
  where upper(ic.code) = upper(p_code)
    and ic.application_id is null
    and ic.answerer_id is null
  for update skip locked;
  if v_code_id is null then
    raise exception '邀请码无效或已被使用';
  end if;

  insert into public.keyflow_answerers (
    invitation_code_id, auth_user_id, zhihu_name, account_address, wechat_id, password_hash
  ) values (
    v_code_id, auth.uid(), p_zhihu_name, coalesce(p_account_address, ''), coalesce(p_wechat_id, ''), ''
  ) returning keyflow_answerers.id into v_answerer_id;

  update public.keyflow_invitation_codes
  set answerer_id = v_answerer_id, used_at = now()
  where id = v_code_id;
  insert into public.keyflow_user_roles (user_id, role)
  values (auth.uid(), 'answerer')
  on conflict (user_id) do update set role = excluded.role;

  return query
  select a.id, a.serial_number, a.zhihu_name, a.account_address, a.avatar_url, a.created_at
  from public.keyflow_answerers a
  where a.id = v_answerer_id;
end;
$$;

revoke all on function public.keyflow_my_answerer_profile() from public;
revoke all on function public.keyflow_admin_answerer_summaries() from public;
revoke all on function public.keyflow_create_my_answerer(text, text, text, text) from public;
grant execute on function public.keyflow_my_answerer_profile() to authenticated;
grant execute on function public.keyflow_admin_answerer_summaries() to authenticated;
grant execute on function public.keyflow_create_my_answerer(text, text, text, text) to authenticated;
