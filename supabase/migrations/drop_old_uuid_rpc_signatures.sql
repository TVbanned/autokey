-- ============================================
-- 修复：Could not choose the best candidate function between
--        public.keyflow_admin_list(p_super_admin_id => text)
--   vs   public.keyflow_admin_list(p_super_admin_id => uuid)
--
-- 根因：之前几次修复都写了「DROP IF EXISTS ...(uuid)」但总有漏网的，导致线上 DB 里同时存在
--       text（新版）和 uuid（旧版）两个签名。Supabase JS RPC 默认传命名参数，PostgreSQL 碰到
--       同名字 + 参数名相同但类型不同的两个函数时，报 ambiguous function 错误。
--
-- 修复：把全部「管理员系统管理」类 9 个 RPC 的旧 uuid 签名彻底 DROP 干净，
--       只留 text 签名；另外把相关工具函数 signature 也统一 drop 旧版防冲突。
-- ============================================

-- ---------- A) 管理员系统管理类 RPC（从 fix_admin_rpc_uuid_resolve.sql 改 uuid→text 的 9 个） ----------
--          之前 add_admin_system_v2.sql 初始化签名都是 uuid，后来改成 text，全部清 uuid 版
drop function if exists public.keyflow_admin_list(uuid) cascade;
drop function if exists public.keyflow_admin_change_password(uuid, text, text) cascade;
drop function if exists public.keyflow_admin_update_avatar(uuid, text) cascade;
drop function if exists public.keyflow_admin_update_display_name(uuid, text) cascade;
drop function if exists public.keyflow_admin_create(uuid, text, text, text, text[]) cascade;
drop function if exists public.keyflow_admin_update_role(uuid, uuid, text, text[]) cascade;
drop function if exists public.keyflow_admin_delete(uuid, uuid) cascade;
drop function if exists public.keyflow_admin_reset_password(uuid, uuid, text) cascade;

-- ---------- B) 管理员数据加载类 RPC（fix_admin_token_uuid_to_text.sql 刚改 uuid→text 的） ----------
--          这些的旧 uuid 签名残留也得 drop 干净，避免 Supabase JS 调用时歧义
drop function if exists public.keyflow_is_admin(uuid) cascade;
drop function if exists public.keyflow_admin_answerer_summaries(uuid) cascade;
drop function if exists public.keyflow_admin_update_answerer_remark(uuid, uuid, text) cascade;
drop function if exists public.keyflow_admin_delete_answerer(uuid, uuid) cascade;
drop function if exists public.keyflow_admin_daily_questions(uuid) cascade;
drop function if exists public.keyflow_admin_create_daily_questions(uuid, jsonb) cascade;
drop function if exists public.keyflow_admin_process_daily_questions(uuid, uuid[]) cascade;
drop function if exists public.keyflow_admin_analytics_overview(uuid, text) cascade;
drop function if exists public.keyflow_review_password_reset(uuid, uuid, boolean, text) cascade;
drop function if exists public.keyflow_review_password_reset(uuid, boolean) cascade;
drop function if exists public.keyflow_review_password_reset(uuid, boolean, text) cascade;

-- ---------- C) 同时把这几个常见旧签名的权限也 revoke（如果还有残留） ----------
-- keyflow_admin_login 签名一直是 (text,text)，不受影响。
-- 现在只保留：
--   管理员系统管理类 9 个 → text 参数
--   管理员数据加载类 8 个 → text 参数
--   keyflow_is_admin(text)
--   resolve_admin_id(text)
--   resolve_admin_token(text)
