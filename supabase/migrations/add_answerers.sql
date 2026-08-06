-- 答主账号表：注册后成为平台答主，可参与多个活动
create table if not exists public.keyflow_answerers (
  id uuid primary key default gen_random_uuid(),
  invitation_code_id uuid unique references public.keyflow_invitation_codes(id) on delete set null,
  zhihu_name text not null,
  account_address text not null default '',
  password_hash text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists keyflow_answerers_zhihu_name_idx on public.keyflow_answerers(zhihu_name);

-- 邀请码表增加 answerer_id，支持注册答主场景
alter table public.keyflow_invitation_codes
  add column if not exists answerer_id uuid unique references public.keyflow_answerers(id) on delete set null;

alter table public.keyflow_answerers enable row level security;
create policy "keyflow public answerer access"
  on public.keyflow_answerers for all to anon, authenticated
  using (true) with check (true);

-- RPC: 答主注册（原子操作：验码 + 创建答主 + 绑定邀请码）
create or replace function public.keyflow_register_answerer(
  p_code text,
  p_zhihu_name text,
  p_account_address text,
  p_password text
)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_code_id uuid;
  v_answerer_id uuid;
  v_answerer record;
begin
  -- 原子检查并锁定邀请码
  select id into v_code_id
  from keyflow_invitation_codes
  where upper(code) = upper(p_code)
    and application_id is null
    and answerer_id is null
  for update skip locked;

  if v_code_id is null then
    raise exception '邀请码无效或已被使用';
  end if;

  -- 创建答主账号
  insert into keyflow_answerers (invitation_code_id, zhihu_name, account_address, password_hash)
  values (v_code_id, p_zhihu_name, coalesce(p_account_address, ''), crypt(p_password, gen_salt('bf')))
  returning id into v_answerer_id;

  -- 绑定邀请码
  update keyflow_invitation_codes
  set answerer_id = v_answerer_id, used_at = now()
  where id = v_code_id;

  select id, zhihu_name, account_address, created_at
  into v_answerer
  from keyflow_answerers where id = v_answerer_id;

  return row_to_json(v_answerer);
end;
$$;

grant execute on function public.keyflow_register_answerer(text, text, text, text) to anon, authenticated;

-- RPC: 答主登录（zhihu_name + password 验证）
create or replace function public.keyflow_login_answerer(
  p_zhihu_name text,
  p_password text
)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_answerer record;
begin
  select id, zhihu_name, account_address, created_at
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
