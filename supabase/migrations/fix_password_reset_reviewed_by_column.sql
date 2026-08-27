-- 修复 keyflow_password_reset_requests 表缺失 reviewed_by 列的问题
-- 后续管理员审核 RPC 写入该列，但表结构中没有此列导致报错

alter table public.keyflow_password_reset_requests
add column if not exists reviewed_by text;

-- 给已有数据补默认空值（避免 not null 约束，现有历史记录无审核人信息）
comment on column public.keyflow_password_reset_requests.reviewed_by is '审核该申请的管理员ID或用户名（text 类型，兼容 resolve_admin_id）';
