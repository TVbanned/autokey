-- 综合活动：完成最少投稿后可获得的额外金币（创建/编辑活动时可配置）
alter table public.keyflow_activities
  add column if not exists completion_reward_coins integer not null default 0 check (completion_reward_coins >= 0);
