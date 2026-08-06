alter table public.keyflow_applications drop constraint if exists keyflow_applications_activity_id_zhihu_id_key;
alter table public.keyflow_applications drop column if exists zhihu_id;
