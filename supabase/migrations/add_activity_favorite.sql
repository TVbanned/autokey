-- 活动看板收藏：收藏状态入库，支持跨设备同步
alter table public.keyflow_activities
  add column if not exists is_favorite boolean not null default false;
