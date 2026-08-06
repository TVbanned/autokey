-- 答主表增加微信号字段
alter table public.keyflow_answerers
  add column if not exists wechat_id text not null default '';

-- 更新 RPC：注册时接受微信号参数
create or replace function public.keyflow_register_answerer(
  p_code text,
  p_zhihu_name text,
  p_account_address text,
  p_password text,
  p_wechat_id text default ''
)
returns json
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_code_id uuid;
  v_answerer_id uuid;
  v_answerer record;
begin
  select id into v_code_id
  from keyflow_invitation_codes
  where upper(code) = upper(p_code)
    and application_id is null
    and answerer_id is null
  for update skip locked;

  if v_code_id is null then
    raise exception '邀请码无效或已被使用';
  end if;

  insert into keyflow_answerers (invitation_code_id, zhihu_name, account_address, wechat_id, password_hash)
  values (v_code_id, p_zhihu_name, coalesce(p_account_address, ''), coalesce(p_wechat_id, ''), crypt(p_password, gen_salt('bf')))
  returning id into v_answerer_id;

  update keyflow_invitation_codes
  set answerer_id = v_answerer_id, used_at = now()
  where id = v_code_id;

  select id, zhihu_name, account_address, wechat_id, created_at
  into v_answerer
  from keyflow_answerers where id = v_answerer_id;

  return row_to_json(v_answerer);
end;
$$;

grant execute on function public.keyflow_register_answerer(text, text, text, text, text) to anon, authenticated;
