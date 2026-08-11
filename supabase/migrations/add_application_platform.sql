alter table public.keyflow_applications add column if not exists platform text not null default 'steam';
