alter table public.keyflow_applications
  add column if not exists selected_platform text not null default 'steam';

notify pgrst, 'reload schema';
