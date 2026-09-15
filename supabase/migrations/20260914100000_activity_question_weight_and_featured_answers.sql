alter table public.keyflow_activity_questions
  add column if not exists weight integer not null default 0 check (weight between 0 and 100);

create index if not exists keyflow_activity_questions_weight_idx
  on public.keyflow_activity_questions (activity_id, weight desc, position asc);

create table if not exists public.keyflow_activity_featured_answers (
  id uuid primary key default gen_random_uuid(),
  activity_id uuid not null references public.keyflow_activities(id) on delete cascade,
  answer_text text not null default '',
  answer_url text not null default '',
  position integer not null default 0,
  created_at timestamptz not null default now()
);

alter table public.keyflow_activity_featured_answers enable row level security;
drop policy if exists "keyflow public featured answers access" on public.keyflow_activity_featured_answers;
create policy "keyflow public featured answers access" on public.keyflow_activity_featured_answers
  for all to anon, authenticated using (true) with check (true);

create index if not exists keyflow_activity_featured_answers_activity_idx
  on public.keyflow_activity_featured_answers (activity_id, position);
