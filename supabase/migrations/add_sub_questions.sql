alter table public.keyflow_activities add column if not exists sub_questions text not null default '[]';
