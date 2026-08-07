-- 前端实时检测知乎主页地址是否已被其他用户占用
create or replace function public.keyflow_check_account_address(p_address text)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_existing_name text;
begin
  select zhihu_name into v_existing_name
  from keyflow_answerers
  where account_address = p_address
  limit 1;

  if v_existing_name is null then
    return json_build_object('exists', false);
  end if;

  return json_build_object('exists', true, 'zhihu_name', v_existing_name);
end;
$$;

grant execute on function public.keyflow_check_account_address(text) to anon, authenticated;

-- 注册 RPC 同时增加知乎主页地址唯一性校验
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
  v_suggested_name text;
  v_suffix int := 1;
  v_existing_name text;
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

  -- 检查知乎用户名是否已被占用
  if exists (select 1 from keyflow_answerers where zhihu_name = p_zhihu_name) then
    loop
      v_suggested_name := p_zhihu_name || lpad(v_suffix::text, 2, '0');
      if not exists (select 1 from keyflow_answerers where zhihu_name = v_suggested_name) then
        exit;
      end if;
      v_suffix := v_suffix + 1;
    end loop;
    raise exception 'duplicate_zhihu_name: 知乎用户名 "%" 已被使用，建议使用 "%"', p_zhihu_name, v_suggested_name;
  end if;

  -- 检查知乎主页地址是否已被其他用户占用
  select zhihu_name into v_existing_name
  from keyflow_answerers
  where account_address = p_account_address
  limit 1;

  if v_existing_name is not null then
    raise exception 'duplicate_account_address: 该知乎主页地址已被用户 "%" 使用，你确定这是你的知乎账户吗？', v_existing_name;
  end if;

  insert into keyflow_answerers (invitation_code_id, zhihu_name, account_address, wechat_id, password_hash)
  values (v_code_id, p_zhihu_name, coalesce(p_account_address, ''), coalesce(p_wechat_id, ''), crypt(p_password, gen_salt('bf')))
  returning id into v_answerer_id;

  update keyflow_invitation_codes
  set answerer_id = v_answerer_id, used_at = now()
  where id = v_code_id;

  select id, zhihu_name, account_address, wechat_id, serial_number, created_at
  into v_answerer
  from keyflow_answerers where id = v_answerer_id;

  return row_to_json(v_answerer);
end;
$$;
