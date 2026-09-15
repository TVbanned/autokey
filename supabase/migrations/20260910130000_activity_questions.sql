-- 综合活动问题库：从腾讯文档同步的问题清单
create table if not exists public.keyflow_activity_questions (
  id uuid primary key default gen_random_uuid(),
  activity_id uuid not null references public.keyflow_activities(id) on delete cascade,
  question_text text not null default '',
  question_url text not null default '',
  position integer not null default 0,
  created_at timestamptz not null default now()
);
alter table public.keyflow_activity_questions enable row level security;
drop policy if exists "keyflow public activity questions access" on public.keyflow_activity_questions;
create policy "keyflow public activity questions access" on public.keyflow_activity_questions
  for all to anon, authenticated using (true) with check (true);
create index if not exists keyflow_activity_questions_activity_idx
  on public.keyflow_activity_questions (activity_id, position);

-- 存量综合活动：以活动开始时间作为排序用的发售日期
update public.keyflow_activities
set release_date = activity_start_time
where activity_type = 'comprehensive' and release_date is null and activity_start_time is not null;
