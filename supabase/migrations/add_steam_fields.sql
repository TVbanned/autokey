alter table public.keyflow_activities add column if not exists steam_url text not null default '';
alter table public.keyflow_activities add column if not exists game_cover text not null default '';
