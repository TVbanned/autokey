-- 性能优化：添加缺失的数据库索引

-- 1. HomePage 活动列表查询：is_online + created_at 排序
CREATE INDEX IF NOT EXISTS keyflow_activities_online_created_idx 
  ON keyflow_activities (is_online, created_at DESC);

-- 2. 收件箱查询：to_id + type + status + created_at 组合索引
CREATE INDEX IF NOT EXISTS keyflow_inbox_to_type_status_created_idx 
  ON keyflow_inbox (to_id, type, status, created_at DESC);

-- 3. 密码重置请求：answerer_id + requested_at 排序
CREATE INDEX IF NOT EXISTS keyflow_pwd_reset_answerer_requested_idx 
  ON keyflow_password_reset_requests (answerer_id, requested_at DESC);
