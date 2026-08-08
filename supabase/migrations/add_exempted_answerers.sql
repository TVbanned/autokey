alter table public.keyflow_activities 
add column if not exists exempted_answerer_ids jsonb not null default '[]';
