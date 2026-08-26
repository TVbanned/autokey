-- ⚠️ 紧急修复：之前的 v2 迁移里把「灰域信风」密码硬重置成 admin123 了，
-- 用户原密码是 526187913，现在改回来。admin 保持 admin123 不变。
create extension if not exists pgcrypto;

update keyflow_admin_users ku
set password_hash = crypt('526187913', gen_salt('bf')),
    updated_at = now()
where ku.username = '灰域信风';

-- ⚠️ 顺带确保灰域信风是 super_admin 角色（避免白名单命中但 DB 没同步）
update keyflow_admin_users ku
set role = 'super_admin',
    permissions = (
      select array(select unnest(
        coalesce(ku.permissions, '{}'::text[])
        || array['activity_manage','application_review','key_manage','delivery_review','answerer_manage','partner_manage','daily_question_manage','page_edit','inbox_private_message','data_overview']
      ))
    ),
    updated_at = now()
where ku.username = '灰域信风' and (ku.role is null or ku.role <> 'super_admin');
