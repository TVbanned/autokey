-- 日常问题运营：管理员维护标题与知乎问题地址。
create table if not exists public.keyflow_daily_questions (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  zhihu_url text not null,
  processed boolean not null default false,
  processed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint keyflow_daily_questions_zhihu_url_key unique (zhihu_url)
);

alter table public.keyflow_daily_questions enable row level security;
revoke all on table public.keyflow_daily_questions from anon, authenticated;

drop function if exists public.keyflow_admin_daily_questions(uuid);
create or replace function public.keyflow_admin_daily_questions(p_token uuid)
returns setof public.keyflow_daily_questions
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
  select q.*
  from public.keyflow_daily_questions q
  order by q.created_at desc;
end;
$$;

drop function if exists public.keyflow_admin_create_daily_questions(uuid, jsonb);
create or replace function public.keyflow_admin_create_daily_questions(
  p_token uuid,
  p_questions jsonb
)
returns setof public.keyflow_daily_questions
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.keyflow_is_admin(p_token) then
    raise exception '管理员权限不足';
  end if;

  return query
  insert into public.keyflow_daily_questions (title, zhihu_url)
  select trim(item->>'title'), split_part(trim(item->>'zhihu_url'), '?', 1)
  from jsonb_array_elements(coalesce(p_questions, '[]'::jsonb)) item
  where trim(coalesce(item->>'title', '')) <> ''
    and trim(coalesce(item->>'zhihu_url', '')) ~* '^https?://(www[.])?zhihu[.]com/'
  on conflict (zhihu_url) do update
    set title = excluded.title,
        updated_at = now()
  returning *;
end;
$$;

create or replace function public.keyflow_admin_process_daily_questions(
  p_token uuid,
  p_ids uuid[]
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

  update public.keyflow_daily_questions
  set processed = true,
      processed_at = now(),
      updated_at = now()
  where id = any(p_ids);
end;
$$;

revoke all on function public.keyflow_admin_daily_questions(uuid) from public;
revoke all on function public.keyflow_admin_create_daily_questions(uuid, jsonb) from public;
revoke all on function public.keyflow_admin_process_daily_questions(uuid, uuid[]) from public;
grant execute on function public.keyflow_admin_daily_questions(uuid) to anon;
grant execute on function public.keyflow_admin_create_daily_questions(uuid, jsonb) to anon;
grant execute on function public.keyflow_admin_process_daily_questions(uuid, uuid[]) to anon;
