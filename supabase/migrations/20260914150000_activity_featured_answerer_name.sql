alter table public.keyflow_activity_featured_answers
  add column if not exists answerer_name text not null default '';
