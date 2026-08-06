-- 答主表增加可读序号，序数从小到大（按注册时间递增）
create sequence if not exists keyflow_answerers_serial_seq start with 1;

alter table public.keyflow_answerers
  add column if not exists serial_number integer;

-- 已有用户按注册时间顺序分配序号
do $$
declare
  r record;
begin
  for r in select id from keyflow_answerers order by created_at asc loop
    update keyflow_answerers
    set serial_number = nextval('keyflow_answerers_serial_seq')
    where id = r.id;
  end loop;
end;
$$;

-- 新增用户自动取下一个序号
alter table public.keyflow_answerers
  alter column serial_number set not null,
  alter column serial_number set default nextval('keyflow_answerers_serial_seq');

-- 更新注册 RPC：创建成功后返回序号
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

  select id, zhihu_name, account_address, wechat_id, serial_number, created_at
  into v_answerer
  from keyflow_answerers where id = v_answerer_id;

  return row_to_json(v_answerer);
end;
$$;

grant execute on function public.keyflow_register_answerer(text, text, text, text, text) to anon, authenticated;

-- 登录 RPC 也返回序号
create or replace function public.keyflow_login_answerer(
  p_zhihu_name text,
  p_password text
)
returns json
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_answerer record;
begin
  select id, zhihu_name, account_address, serial_number, created_at
  into v_answerer
  from keyflow_answerers
  where zhihu_name = p_zhihu_name
    and password_hash = crypt(p_password, password_hash);

  if v_answerer.id is null then
    raise exception '知乎用户名或密码错误';
  end if;

  return row_to_json(v_answerer);
end;
$$;

grant execute on function public.keyflow_login_answerer(text, text) to anon, authenticated;
