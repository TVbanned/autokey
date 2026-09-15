-- 综合活动：参与活动要求与最少提交作品数
alter table public.keyflow_activities
  add column if not exists participation_requirements text,
  add column if not exists min_submission_count integer not null default 1;

update public.keyflow_activities
set min_submission_count = greatest(1, coalesce(min_submission_count, 1));
