alter table public.keyflow_activities add column if not exists game_screenshots text not null default '[]';
