create table if not exists public.keyflow_zhihu_questions_cache (
  cache_key text primary key,
  questions jsonb not null default '[]'::jsonb,
  zhihu_user jsonb not null default '{}'::jsonb,
  fetched_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.keyflow_zhihu_questions_cache enable row level security;

create policy "keyflow zhihu questions cache no public access"
  on public.keyflow_zhihu_questions_cache for all to anon, authenticated
  using (false) with check (false);
