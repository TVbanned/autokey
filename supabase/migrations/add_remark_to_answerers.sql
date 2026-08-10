-- 答主表增加备注字段
alter table public.keyflow_answerers
  add column if not exists remark text not null default '';
