-- 仅供 answerer-auth-bootstrap Edge Function 使用的安全注册入口。
create or replace function public.keyflow_register_answerer_for_auth(
  p_auth_user_id uuid,
  p_code text,
  p_zhihu_name text,
  p_account_address text,
  p_wechat_id text,
  p_password text
)
returns uuid
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_code_id uuid;
  v_answerer_id uuid;
  v_suggested_name text;
  v_suffix integer := 1;
begin
  if p_auth_user_id is null then
    raise exception '认证账号无效';
  end if;
  if btrim(coalesce(p_code, '')) = '' then
    raise exception '请输入邀请码';
  end if;
  if btrim(coalesce(p_zhihu_name, '')) = '' then
    raise exception '请输入知乎用户名';
  end if;
  if btrim(coalesce(p_account_address, '')) = '' then
    raise exception '请输入知乎主页地址';
  end if;
  if btrim(coalesce(p_wechat_id, '')) = '' then
    raise exception '请输入微信号';
  end if;
  if length(coalesce(p_password, '')) < 6 then
    raise exception '密码至少 6 位';
  end if;

  -- Serialize equal profile identifiers so the uniqueness checks and insert are atomic.
  perform pg_advisory_xact_lock(hashtextextended(btrim(p_zhihu_name), 0));
  perform pg_advisory_xact_lock(hashtextextended(btrim(p_account_address), 0));

  select ic.id into v_code_id
  from public.keyflow_invitation_codes ic
  where upper(ic.code) = upper(btrim(p_code))
    and ic.application_id is null
    and ic.answerer_id is null
  for update skip locked;

  if v_code_id is null then
    raise exception '邀请码无效或已被使用';
  end if;

  if exists (
    select 1 from public.keyflow_answerers
    where zhihu_name = btrim(p_zhihu_name)
  ) then
    loop
      v_suggested_name := btrim(p_zhihu_name) || lpad(v_suffix::text, 2, '0');
      exit when not exists (
        select 1 from public.keyflow_answerers where zhihu_name = v_suggested_name
      );
      v_suffix := v_suffix + 1;
    end loop;
    raise exception 'duplicate_zhihu_name: 知乎用户名 "%" 已被使用，建议使用 "%"', btrim(p_zhihu_name), v_suggested_name;
  end if;

  if exists (
    select 1 from public.keyflow_answerers
    where account_address = btrim(p_account_address)
  ) then
    raise exception 'duplicate_account_address: 该知乎主页地址已被使用';
  end if;

  insert into public.keyflow_answerers (
    invitation_code_id, auth_user_id, zhihu_name, account_address, wechat_id, password_hash
  ) values (
    v_code_id,
    p_auth_user_id,
    btrim(p_zhihu_name),
    btrim(p_account_address),
    btrim(p_wechat_id),
    extensions.crypt(p_password, extensions.gen_salt('bf'))
  ) returning id into v_answerer_id;

  update public.keyflow_invitation_codes
  set answerer_id = v_answerer_id, used_at = now()
  where id = v_code_id;

  insert into public.keyflow_user_roles (user_id, role)
  values (p_auth_user_id, 'answerer')
  on conflict (user_id) do update set role = excluded.role;

  return v_answerer_id;
end;
$$;

revoke all on function public.keyflow_register_answerer_for_auth(uuid, text, text, text, text, text) from public;
revoke all on function public.keyflow_register_answerer_for_auth(uuid, text, text, text, text, text) from anon, authenticated;
grant execute on function public.keyflow_register_answerer_for_auth(uuid, text, text, text, text, text) to service_role;
