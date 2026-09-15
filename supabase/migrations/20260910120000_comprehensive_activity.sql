-- 综合活动（知乎圆桌/话题）支持：活动类型、问题库来源、起止时间、奖励信息
alter table public.keyflow_activities
  add column if not exists activity_type text not null default 'game',
  add column if not exists question_bank_url text,
  add column if not exists activity_start_time timestamptz,
  add column if not exists activity_end_time timestamptz,
  add column if not exists reward_info text;

create index if not exists keyflow_activities_activity_type_idx
  on public.keyflow_activities (activity_type);
