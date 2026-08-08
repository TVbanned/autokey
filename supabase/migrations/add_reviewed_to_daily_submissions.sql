-- 日常投稿新增已读状态
alter table public.keyflow_daily_submissions add column if not exists reviewed boolean not null default false;
