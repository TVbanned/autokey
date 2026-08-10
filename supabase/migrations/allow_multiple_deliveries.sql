-- 允许同一报名提交多次交付（移除 application_id 的唯一约束）
alter table public.keyflow_deliveries drop constraint if exists keyflow_deliveries_application_id_key;

-- 添加普通索引以保持查询性能
create index if not exists keyflow_deliveries_application_id_idx on public.keyflow_deliveries(application_id);
