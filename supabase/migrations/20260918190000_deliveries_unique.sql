-- 交付表唯一约束（2026-09-18）
--
-- 背景：日常投稿表、综合活动投稿表 9/18 已加「同答主同链接只能一次」的唯一索引，
--   但 keyflow_deliveries（申领页交付）当时没有，历史上真出现过同一报名同一链接交两次
--   （1 组：灰域信风 2026-08-08 测试数据 http://www.1231341.com，隔 35 秒）。
--   重复交付 = 多一份 40 经验，也说明库层之外还有入口没被兜住。
--
-- 数据清理（备份表 keyflow_deliveries_dup_backup_20260918）见 codex-trae-sync/db-20260918-deliveries-unique.sql。
-- 跨表（日常 / 综合活动 / 交付三张表之间）的重复由 20260918210000_cross_entry_dup_guard.sql 的触发器兜底。
--
-- 回滚：drop index if exists public.keyflow_deliveries_application_url_key;

create unique index if not exists keyflow_deliveries_application_url_key
  on public.keyflow_deliveries (application_id, article_url);
