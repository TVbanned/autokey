-- 活动表上线开关默认改为未上线（仅影响新创建的活动，存量数据不受影响）
alter table public.keyflow_activities
  alter column is_online set default false;
