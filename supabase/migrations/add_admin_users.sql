-- 管理员账号表：运营方管理员登录后台使用
create table if not exists public.keyflow_admin_users (
  id uuid primary key default gen_random_uuid(),
  username text not null unique,
  password_hash text not null,
  display_name text not null default '',
  created_at timestamptz not null default now()
);

alter table public.keyflow_admin_users enable row level security;

-- 管理员表不对外开放查询
create policy "keyflow admin users no public access"
  on public.keyflow_admin_users for all to anon, authenticated
  using (false) with check (false);

-- RPC: 管理员登录
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
begin
  select id, username, display_name, created_at
  into v_admin
  from keyflow_admin_users
  where username = p_username
    and password_hash = crypt(p_password, password_hash);

  if v_admin.id is null then
    raise exception '用户名或密码错误';
  end if;

  return row_to_json(v_admin);
end;
$$;

grant execute on function public.keyflow_admin_login(text, text) to anon, authenticated;

-- 插入默认管理员账号：admin / admin123
insert into keyflow_admin_users (username, password_hash, display_name)
values ('admin', crypt('admin123', gen_salt('bf')), '管理员')
on conflict (username) do nothing;
