-- 删除旧的 keyflow_generate_invitation_codes 重载，只保留 (integer, text) 版本
drop function if exists public.keyflow_generate_invitation_codes(uuid, integer);
drop function if exists public.keyflow_generate_invitation_codes(integer);
