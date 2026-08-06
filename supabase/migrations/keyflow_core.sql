create extension if not exists pgcrypto;

create table if not exists public.keyflow_activities (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  game_name text not null,
  description text not null default '',
  rules text not null default '',
  main_question text not null default '',
  application_deadline timestamptz,
  delivery_deadline timestamptz,
  target_authors integer not null default 20,
  status text not null default 'recruiting' check (status in ('draft', 'recruiting', 'key_distribution', 'delivery', 'completed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.keyflow_applications (
  id uuid primary key default gen_random_uuid(),
  activity_id uuid not null references public.keyflow_activities(id) on delete cascade,
  zhihu_id text not null,
  zhihu_name text not null,
  wechat_name text not null,
  profile_url text not null,
  expected_word_count integer not null,
  status text not null default 'pending' check (status in ('pending', 'selected', 'rejected')),
  reviewer_note text not null default '',
  submitted_at timestamptz not null default now(),
  reviewed_at timestamptz,
  unique (activity_id, zhihu_id)
);

create table if not exists public.keyflow_keys (
  id uuid primary key default gen_random_uuid(),
  activity_id uuid not null references public.keyflow_activities(id) on delete cascade,
  key_value text not null,
  application_id uuid unique references public.keyflow_applications(id) on delete set null,
  claimed_at timestamptz,
  created_at timestamptz not null default now(),
  unique (activity_id, key_value)
);

create table if not exists public.keyflow_deliveries (
  id uuid primary key default gen_random_uuid(),
  application_id uuid not null unique references public.keyflow_applications(id) on delete cascade,
  article_url text not null,
  claimed_word_count integer,
  verified_word_count integer,
  status text not null default 'pending' check (status in ('pending', 'approved', 'revision_required', 'rejected')),
  reviewer_note text not null default '',
  submitted_at timestamptz not null default now(),
  reviewed_at timestamptz
);

create index if not exists keyflow_applications_activity_status_idx on public.keyflow_applications(activity_id, status);
create index if not exists keyflow_keys_activity_available_idx on public.keyflow_keys(activity_id) where application_id is null;

alter table public.keyflow_activities enable row level security;
alter table public.keyflow_applications enable row level security;
alter table public.keyflow_keys enable row level security;
alter table public.keyflow_deliveries enable row level security;

create policy "keyflow public activity access" on public.keyflow_activities for all to anon, authenticated using (true) with check (true);
create policy "keyflow public application access" on public.keyflow_applications for all to anon, authenticated using (true) with check (true);
create policy "keyflow public delivery access" on public.keyflow_deliveries for all to anon, authenticated using (true) with check (true);
-- Key 明文不允许前端直接查询；只能由定向领取函数返回。

create or replace function public.keyflow_claim_key(p_application_id uuid)
returns table(key_value text, claimed_at timestamptz)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_activity_id uuid;
  v_key_id uuid;
begin
  select activity_id into v_activity_id from keyflow_applications where id = p_application_id and status = 'selected';
  if v_activity_id is null then
    raise exception '该答主尚未入选或不存在';
  end if;

  select k.id into v_key_id from keyflow_keys k
  where k.activity_id = v_activity_id and k.application_id is null
  order by k.created_at
  for update skip locked
  limit 1;

  if v_key_id is null then
    raise exception '暂无可领取的 Key';
  end if;

  update keyflow_keys set application_id = p_application_id, claimed_at = now() where id = v_key_id;
  return query select k.key_value, k.claimed_at from keyflow_keys k where k.id = v_key_id;
end;
$$;

grant execute on function public.keyflow_claim_key(uuid) to anon, authenticated;
