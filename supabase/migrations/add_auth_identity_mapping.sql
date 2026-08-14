-- 将业务答主和 Supabase Auth 用户关联；业务主键保持不变，避免影响现有外键。
alter table public.keyflow_answerers
  add column if not exists auth_user_id uuid unique references auth.users(id) on delete set null;

create table if not exists public.keyflow_user_roles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  role text not null check (role in ('answerer', 'admin', 'partner')),
  created_at timestamptz not null default now()
);

alter table public.keyflow_user_roles enable row level security;

create or replace function public.keyflow_current_answerer_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select id
  from public.keyflow_answerers
  where auth_user_id = auth.uid()
$$;

create or replace function public.keyflow_is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.keyflow_user_roles
    where user_id = auth.uid()
      and role = 'admin'
  )
$$;

revoke all on table public.keyflow_user_roles from anon, authenticated;
grant execute on function public.keyflow_current_answerer_id() to authenticated;
grant execute on function public.keyflow_is_admin() to authenticated;
