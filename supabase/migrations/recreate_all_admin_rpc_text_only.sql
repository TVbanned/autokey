-- ============================================
-- 终极修复：
-- 1. 彻底 DROP 所有「管理员 RPC」旧 uuid 签名（消除 could not choose candidate）
-- 2. 完整重建全部「管理员 RPC」最新版 text 签名（DROP CASCADE 会丢权限，这里直接 recreate + regrant）
--    防止 DROP 后权限丢失变成「permission denied」→ 前端显示「登录状态已失效」
-- ============================================

-- ---------- 1) 先 DROP 全部管理员相关 RPC（text 版 + uuid 版一起删，然后重建 text 版） ----------
-- 管理员系统管理 9 个
drop function if exists public.keyflow_admin_list(uuid) cascade;
drop function if exists public.keyflow_admin_list(text) cascade;
drop function if exists public.keyflow_admin_change_password(uuid, text, text) cascade;
drop function if exists public.keyflow_admin_change_password(text, text, text) cascade;
drop function if exists public.keyflow_admin_update_avatar(uuid, text) cascade;
drop function if exists public.keyflow_admin_update_avatar(text, text) cascade;
drop function if exists public.keyflow_admin_update_display_name(uuid, text) cascade;
drop function if exists public.keyflow_admin_update_display_name(text, text) cascade;
drop function if exists public.keyflow_admin_create(uuid, text, text, text, text[]) cascade;
drop function if exists public.keyflow_admin_create(text, text, text, text, text[]) cascade;
drop function if exists public.keyflow_admin_update_role(uuid, uuid, text, text[]) cascade;
drop function if exists public.keyflow_admin_update_role(text, text, text, text[]) cascade;
drop function if exists public.keyflow_admin_delete(uuid, uuid) cascade;
drop function if exists public.keyflow_admin_delete(text, text) cascade;
drop function if exists public.keyflow_admin_reset_password(uuid, uuid, text) cascade;
drop function if exists public.keyflow_admin_reset_password(text, text, text) cascade;
-- 管理员数据加载类
drop function if exists public.keyflow_is_admin(uuid) cascade;
drop function if exists public.keyflow_is_admin(text) cascade;
drop function if exists public.resolve_admin_id(text) cascade;
drop function if exists public.resolve_admin_token(text) cascade;
drop function if exists public.keyflow_admin_answerer_summaries(uuid) cascade;
drop function if exists public.keyflow_admin_answerer_summaries(text) cascade;
drop function if exists public.keyflow_admin_update_answerer_remark(uuid, uuid, text) cascade;
drop function if exists public.keyflow_admin_update_answerer_remark(text, uuid, text) cascade;
drop function if exists public.keyflow_admin_delete_answerer(uuid, uuid) cascade;
drop function if exists public.keyflow_admin_delete_answerer(text, uuid) cascade;
drop function if exists public.keyflow_admin_daily_questions(uuid) cascade;
drop function if exists public.keyflow_admin_daily_questions(text) cascade;
drop function if exists public.keyflow_admin_create_daily_questions(uuid, jsonb) cascade;
drop function if exists public.keyflow_admin_create_daily_questions(text, jsonb) cascade;
drop function if exists public.keyflow_admin_process_daily_questions(uuid, uuid[]) cascade;
drop function if exists public.keyflow_admin_process_daily_questions(text, uuid[]) cascade;
drop function if exists public.keyflow_admin_analytics_overview(uuid, text) cascade;
drop function if exists public.keyflow_admin_analytics_overview(text, text) cascade;
drop function if exists public.keyflow_review_password_reset(uuid, uuid, boolean, text) cascade;
drop function if exists public.keyflow_review_password_reset(uuid, boolean) cascade;
drop function if exists public.keyflow_review_password_reset(uuid, boolean, text) cascade;
drop function if exists public.keyflow_review_password_reset(text, uuid, boolean, text) cascade;

-- ---------- 2) 重建辅助 resolve_admin_id / resolve_admin_token ----------
create or replace function public.resolve_admin_id(p_input text)
returns uuid
language plpgsql
set search_path = public
as $$
declare
  v_id uuid;
begin
  if p_input is null then return null; end if;
  -- A) 标准 UUID 格式，直接强转
  if p_input ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then
    begin
      v_id := p_input::uuid;
      return v_id;
    exception when others then
      v_id := null;
    end;
  end if;
  -- B) 64 hex token → 去 session_token 列查
  if p_input ~ '^[0-9a-fA-F]{64}$' then
    select ku.id into v_id from keyflow_admin_users ku
    where ku.session_token = p_input and ku.session_token is not null limit 1;
    return v_id;
  end if;
  -- C) 当 username 查
  select ku.id into v_id from keyflow_admin_users ku where ku.username = p_input limit 1;
  return v_id;
end;
$$;

create or replace function public.resolve_admin_token(p_input text)
returns uuid
language plpgsql
set search_path = public
as $$
declare
  v_id uuid;
begin
  if p_input is null then return null; end if;
  -- A) 直接按 session_token 匹配（text 列存啥都行）
  select ku.id into v_id
  from keyflow_admin_users ku
  where ku.session_token = p_input
    and ku.session_token is not null
  limit 1;
  if v_id is not null then return v_id; end if;
  -- B) 兜底：当 username 查
  select ku.id into v_id
  from keyflow_admin_users ku
  where ku.username = p_input
  limit 1;
  return v_id;
end;
$$;

-- ---------- 3) 核心鉴权 keyflow_is_admin(text) ----------
create or replace function public.keyflow_is_admin(p_token text)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select public.resolve_admin_token(p_token) is not null;
$$;

-- ---------- 4) 管理员系统管理类 9 个 RPC（最新版 text 参数） ----------
create or replace function public.keyflow_admin_change_password(
  p_admin_id text,
  p_old_password text,
  p_new_password text
) returns void language plpgsql security definer set search_path = public as $$
declare
  v_id uuid; v_old_hash text;
begin
  v_id := resolve_admin_id(p_admin_id);
  if v_id is null then raise exception '登录状态已失效，请重新登录'; end if;
  select ku.password_hash into v_old_hash from keyflow_admin_users ku where ku.id = v_id;
  if v_old_hash is null or v_old_hash <> crypt(p_old_password, v_old_hash) then
    raise exception '原密码错误';
  end if;
  if length(coalesce(p_new_password, '')) < 6 then raise exception '新密码至少 6 位'; end if;
  update keyflow_admin_users set password_hash = crypt(p_new_password, gen_salt('bf')), updated_at = now() where id = v_id;
end;
$$;

create or replace function public.keyflow_admin_update_avatar(
  p_admin_id text,
  p_avatar_url text
) returns void language plpgsql security definer set search_path = public as $$
declare
  v_id uuid;
begin
  v_id := resolve_admin_id(p_admin_id);
  if v_id is null then raise exception '登录状态已失效，请重新登录'; end if;
  update keyflow_admin_users set avatar_url = coalesce(p_avatar_url, ''), updated_at = now() where id = v_id;
end;
$$;

create or replace function public.keyflow_admin_update_display_name(
  p_admin_id text,
  p_display_name text
) returns void language plpgsql security definer set search_path = public as $$
declare
  v_id uuid;
begin
  v_id := resolve_admin_id(p_admin_id);
  if v_id is null then raise exception '登录状态已失效，请重新登录'; end if;
  if trim(coalesce(p_display_name, '')) = '' then raise exception '显示名称不能为空'; end if;
  update keyflow_admin_users set display_name = trim(p_display_name), updated_at = now() where id = v_id;
end;
$$;

create or replace function public.keyflow_admin_list(p_super_admin_id text)
returns table (
  id uuid, username text, display_name text, avatar_url text,
  role text, permissions text[], created_at timestamptz, updated_at timestamptz
) language plpgsql security definer set search_path = public as $$
declare
  v_super uuid;
begin
  v_super := resolve_admin_id(p_super_admin_id);
  if v_super is null then raise exception '登录状态已失效，请重新登录'; end if;
  if not exists (select 1 from keyflow_admin_users ku where ku.id = v_super and ku.role = 'super_admin') then
    raise exception '仅超级管理员可查看管理员列表';
  end if;
  return query
  select ku.id, ku.username, ku.display_name, ku.avatar_url, ku.role,
         coalesce(ku.permissions, '{}'::text[]), ku.created_at, ku.updated_at
  from keyflow_admin_users ku order by ku.created_at asc;
end;
$$;

create or replace function public.keyflow_admin_create(
  p_super_admin_id text,
  p_username text,
  p_display_name text,
  p_initial_password text,
  p_permissions text[]
) returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_super uuid; v_new_id uuid;
begin
  v_super := resolve_admin_id(p_super_admin_id);
  if v_super is null then raise exception '登录状态已失效，请重新登录'; end if;
  if not exists (select 1 from keyflow_admin_users ku where ku.id = v_super and ku.role = 'super_admin') then
    raise exception '仅超级管理员可新建管理员账号';
  end if;
  if trim(coalesce(p_username, '')) = '' then raise exception '用户名不能为空'; end if;
  if exists (select 1 from keyflow_admin_users ku where ku.username = trim(p_username)) then
    raise exception '用户名已存在，请换一个';
  end if;
  if length(coalesce(p_initial_password, '')) < 6 then raise exception '初始密码至少 6 位'; end if;
  insert into keyflow_admin_users (username, display_name, password_hash, role, permissions)
  values (trim(p_username), trim(coalesce(p_display_name, trim(p_username))),
          crypt(p_initial_password, gen_salt('bf')),
          'admin', coalesce(p_permissions, '{}'::text[]))
  returning id into v_new_id;
  return v_new_id;
end;
$$;

create or replace function public.keyflow_admin_update_role(
  p_super_admin_id text,
  p_target_admin_id text,
  p_role text,
  p_permissions text[]
) returns void language plpgsql security definer set search_path = public as $$
declare
  v_super uuid; v_t uuid; v_super_count int;
begin
  v_super := resolve_admin_id(p_super_admin_id);
  if v_super is null then raise exception '登录状态已失效，请重新登录'; end if;
  if not exists (select 1 from keyflow_admin_users ku where ku.id = v_super and ku.role = 'super_admin') then
    raise exception '仅超级管理员可修改角色权限';
  end if;
  v_t := resolve_admin_id(p_target_admin_id);
  if v_t is null then raise exception '目标管理员不存在'; end if;
  if p_role not in ('admin', 'super_admin') then raise exception '角色非法'; end if;
  if v_t = v_super and p_role <> 'super_admin' then
    select count(*) into v_super_count from keyflow_admin_users ku where ku.role = 'super_admin';
    if v_super_count <= 1 then raise exception '不能降级最后一个超级管理员'; end if;
  end if;
  update keyflow_admin_users
  set role = p_role,
      permissions = case when p_role = 'super_admin' then permissions else coalesce(p_permissions, '{}'::text[]) end,
      updated_at = now()
  where id = v_t;
end;
$$;

create or replace function public.keyflow_admin_delete(
  p_super_admin_id text,
  p_target_admin_id text
) returns void language plpgsql security definer set search_path = public as $$
declare
  v_super uuid; v_t uuid; v_super_count int;
begin
  v_super := resolve_admin_id(p_super_admin_id);
  if v_super is null then raise exception '登录状态已失效，请重新登录'; end if;
  if not exists (select 1 from keyflow_admin_users ku where ku.id = v_super and ku.role = 'super_admin') then
    raise exception '仅超级管理员可删除管理员账号';
  end if;
  v_t := resolve_admin_id(p_target_admin_id);
  if v_t is null then raise exception '目标管理员不存在'; end if;
  if v_t = v_super then raise exception '不能删除当前登录的自己'; end if;
  select count(*) into v_super_count from keyflow_admin_users ku where ku.role = 'super_admin';
  if exists (select 1 from keyflow_admin_users ku where ku.id = v_t and ku.role = 'super_admin') and v_super_count <= 1 then
    raise exception '不能删除最后一个超级管理员';
  end if;
  delete from keyflow_admin_users where id = v_t;
end;
$$;

create or replace function public.keyflow_admin_reset_password(
  p_super_admin_id text,
  p_target_admin_id text,
  p_new_password text
) returns void language plpgsql security definer set search_path = public as $$
declare
  v_super uuid; v_t uuid;
begin
  v_super := resolve_admin_id(p_super_admin_id);
  if v_super is null then raise exception '登录状态已失效，请重新登录'; end if;
  if not exists (select 1 from keyflow_admin_users ku where ku.id = v_super and ku.role = 'super_admin') then
    raise exception '仅超级管理员可重置密码';
  end if;
  v_t := resolve_admin_id(p_target_admin_id);
  if v_t is null then raise exception '目标管理员不存在'; end if;
  if length(coalesce(p_new_password, '')) < 6 then raise exception '新密码至少 6 位'; end if;
  update keyflow_admin_users
  set password_hash = crypt(p_new_password, gen_salt('bf')),
      session_token = null,
      updated_at = now()
  where id = v_t;
end;
$$;

-- ---------- 5) 管理员数据加载类 RPC ----------
create or replace function public.keyflow_admin_answerer_summaries(p_token text)
returns table (
  id uuid, serial_number integer, zhihu_name text, account_address text, wechat_id text,
  avatar_url text, remark text, created_at timestamptz, updated_at timestamptz
) language plpgsql stable security definer set search_path = public as $$
begin
  if not public.keyflow_is_admin(p_token) then raise exception '管理员权限不足'; end if;
  return query
  select a.id, a.serial_number, a.zhihu_name, a.account_address, a.wechat_id,
         a.avatar_url, a.remark, a.created_at, a.updated_at
  from public.keyflow_answerers a order by a.created_at desc;
end;
$$;

create or replace function public.keyflow_admin_update_answerer_remark(
  p_token text, p_answerer_id uuid, p_remark text
) returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.keyflow_is_admin(p_token) then raise exception '管理员权限不足'; end if;
  update public.keyflow_answerers
  set remark = coalesce(p_remark, ''), updated_at = now()
  where id = p_answerer_id;
end;
$$;

create or replace function public.keyflow_admin_delete_answerer(
  p_token text, p_answerer_id uuid
) returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.keyflow_is_admin(p_token) then raise exception '管理员权限不足'; end if;
  delete from public.keyflow_answerers where id = p_answerer_id;
end;
$$;

create or replace function public.keyflow_admin_daily_questions(p_token text)
returns setof public.keyflow_daily_questions language plpgsql stable security definer set search_path = public as $$
begin
  if not public.keyflow_is_admin(p_token) then raise exception '管理员权限不足'; end if;
  return query select q.* from public.keyflow_daily_questions q order by q.created_at desc;
end;
$$;

create or replace function public.keyflow_admin_create_daily_questions(
  p_token text, p_questions jsonb
) returns setof public.keyflow_daily_questions language plpgsql security definer set search_path = public as $$
begin
  if not public.keyflow_is_admin(p_token) then raise exception '管理员权限不足'; end if;
  return query
  insert into public.keyflow_daily_questions (title, zhihu_url)
  select trim(item->>'title'), split_part(trim(item->>'zhihu_url'), '?', 1)
  from jsonb_array_elements(coalesce(p_questions, '[]'::jsonb)) item
  where trim(coalesce(item->>'title', '')) <> ''
    and trim(coalesce(item->>'zhihu_url', '')) ~* '^https?://(www[.])?zhihu[.]com/'
  on conflict (zhihu_url) do update set title = excluded.title, updated_at = now()
  returning *;
end;
$$;

create or replace function public.keyflow_admin_process_daily_questions(
  p_token text, p_ids uuid[]
) returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.keyflow_is_admin(p_token) then raise exception '管理员权限不足'; end if;
  update public.keyflow_daily_questions
  set processed = true, processed_at = now(), updated_at = now()
  where id = any(p_ids);
end;
$$;

create or replace function public.keyflow_admin_analytics_overview(
  p_token text, p_search text default ''
) returns json language plpgsql security definer set search_path = public as $$
declare
  v_admin_id uuid;
  v_total_activities int; v_online_activities int; v_total_answerers int; v_new_answerers_7d int;
  v_total_applications int; v_selected_applications int; v_total_keys int; v_claimed_keys int;
  v_total_deliveries int; v_approved_deliveries int; v_total_daily_submissions int; v_total_daily_questions int;
  v_partner_count int;
  v_activity_trend jsonb; v_author_trend jsonb; v_submission_trend jsonb; v_code_trend jsonb; v_top_answerers jsonb;
begin
  v_admin_id := resolve_admin_token(p_token);
  if v_admin_id is null then raise exception '管理员权限不足'; end if;
  select count(*) into v_total_activities from public.keyflow_activities;
  select count(*) into v_online_activities from public.keyflow_activities where is_online is not false;
  select count(*) into v_total_answerers from public.keyflow_answerers;
  select count(*) into v_new_answerers_7d from public.keyflow_answerers where created_at >= now() - interval '7 days';
  select count(*) into v_total_applications from public.keyflow_applications;
  select count(*) into v_selected_applications from public.keyflow_applications where status = 'selected';
  select count(*) into v_total_keys from public.keyflow_keys;
  select count(*) into v_claimed_keys from public.keyflow_keys where claimed_at is not null;
  select count(*) into v_total_deliveries from public.keyflow_deliveries;
  select count(*) into v_approved_deliveries from public.keyflow_deliveries where status = 'approved';
  select count(*) into v_total_daily_submissions from public.keyflow_daily_submissions;
  select count(*) into v_total_daily_questions from public.keyflow_daily_questions;
  select count(distinct partner_answerer_id) into v_partner_count from public.keyflow_activities where partner_answerer_id is not null;

  select coalesce(jsonb_agg(jsonb_build_object('date', to_char(t.dday, 'YYYY-MM-DD'), 'count', coalesce(c.cnt, 0))), '[]'::jsonb)
  into v_activity_trend from generate_series(date_trunc('day', now() - interval '13 days'), date_trunc('day', now()), '1 day') t(dday)
  left join (select date_trunc('day', created_at) dday, count(*) cnt from public.keyflow_activities group by 1) c on c.dday = t.dday;

  select coalesce(jsonb_agg(jsonb_build_object('date', to_char(t.dday, 'YYYY-MM-DD'), 'count', coalesce(c.cnt, 0))), '[]'::jsonb)
  into v_author_trend from generate_series(date_trunc('day', now() - interval '13 days'), date_trunc('day', now()), '1 day') t(dday)
  left join (select date_trunc('day', created_at) dday, count(*) cnt from public.keyflow_answerers group by 1) c on c.dday = t.dday;

  select coalesce(jsonb_agg(jsonb_build_object('date', to_char(t.dday, 'YYYY-MM-DD'), 'count', coalesce(c.cnt, 0))), '[]'::jsonb)
  into v_submission_trend from generate_series(date_trunc('day', now() - interval '13 days'), date_trunc('day', now()), '1 day') t(dday)
  left join (select date_trunc('day', submitted_at) dday, count(*) cnt from public.keyflow_daily_submissions group by 1) c on c.dday = t.dday;

  select coalesce(jsonb_agg(jsonb_build_object('date', to_char(t.dday, 'YYYY-MM-DD'), 'count', coalesce(c.cnt, 0))), '[]'::jsonb)
  into v_code_trend from generate_series(date_trunc('day', now() - interval '13 days'), date_trunc('day', now()), '1 day') t(dday)
  left join (select date_trunc('day', used_at) dday, count(*) cnt from public.keyflow_invitation_codes where used_at is not null group by 1) c on c.dday = t.dday;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', a.id, 'zhihu_name', a.zhihu_name, 'avatar_url', a.avatar_url,
    'participation_count',
      (select count(*) from public.keyflow_applications ap where ap.answerer_id = a.id and ap.status = 'selected') +
      (select count(*) from public.keyflow_daily_submissions ds where ds.answerer_id = a.id)
  ) order by (
    (select count(*) from public.keyflow_applications ap where ap.answerer_id = a.id and ap.status = 'selected') +
    (select count(*) from public.keyflow_daily_submissions ds where ds.answerer_id = a.id)
  ) desc), '[]'::jsonb)
  into v_top_answerers from public.keyflow_answerers a
  where p_search = '' or a.zhihu_name ilike ('%' || p_search || '%') or a.wechat_id ilike ('%' || p_search || '%')
  limit 10;

  return json_build_object(
    'total_activities', v_total_activities, 'online_activities', v_online_activities,
    'total_answerers', v_total_answerers, 'new_answerers_7d', v_new_answerers_7d,
    'total_applications', v_total_applications, 'selected_applications', v_selected_applications,
    'total_keys', v_total_keys, 'claimed_keys', v_claimed_keys,
    'total_deliveries', v_total_deliveries, 'approved_deliveries', v_approved_deliveries,
    'total_daily_submissions', v_total_daily_submissions, 'total_daily_questions', v_total_daily_questions,
    'partner_count', coalesce(v_partner_count, 0),
    'activity_trend', v_activity_trend, 'author_trend', v_author_trend,
    'submission_trend', v_submission_trend, 'code_trend', v_code_trend,
    'top_answerers', v_top_answerers
  );
end;
$$;

create or replace function public.keyflow_review_password_reset(
  p_token text, p_request_id uuid, p_approved boolean, p_admin_note text default ''
) returns boolean language plpgsql security definer set search_path = public as $$
declare
  v_admin_id uuid; v_req record;
begin
  v_admin_id := resolve_admin_token(p_token);
  if v_admin_id is null then raise exception '管理员权限不足'; end if;
  select * into v_req from public.keyflow_password_reset_requests where id = p_request_id and status = 'pending';
  if v_req.id is null then return false; end if;
  update public.keyflow_password_reset_requests
  set status = case when p_approved then 'approved' else 'rejected' end,
      reviewed_at = now(), reviewed_by = v_admin_id, admin_note = coalesce(p_admin_note, '')
  where id = p_request_id;
  return true;
end;
$$;

-- ---------- 6) 权限全量 REGRANT：管理员 RPC 全给 anon，登录 RPC 给 anon + authenticated ----------
revoke all on function public.keyflow_admin_change_password(text, text, text) from public;
revoke all on function public.keyflow_admin_update_avatar(text, text) from public;
revoke all on function public.keyflow_admin_update_display_name(text, text) from public;
revoke all on function public.keyflow_admin_list(text) from public;
revoke all on function public.keyflow_admin_create(text, text, text, text, text[]) from public;
revoke all on function public.keyflow_admin_update_role(text, text, text, text[]) from public;
revoke all on function public.keyflow_admin_delete(text, text) from public;
revoke all on function public.keyflow_admin_reset_password(text, text, text) from public;
revoke all on function public.keyflow_admin_answerer_summaries(text) from public;
revoke all on function public.keyflow_admin_update_answerer_remark(text, uuid, text) from public;
revoke all on function public.keyflow_admin_delete_answerer(text, uuid) from public;
revoke all on function public.keyflow_admin_daily_questions(text) from public;
revoke all on function public.keyflow_admin_create_daily_questions(text, jsonb) from public;
revoke all on function public.keyflow_admin_process_daily_questions(text, uuid[]) from public;
revoke all on function public.keyflow_admin_analytics_overview(text, text) from public;
revoke all on function public.keyflow_review_password_reset(text, uuid, boolean, text) from public;
revoke all on function public.keyflow_is_admin(text) from public;
revoke all on function public.resolve_admin_id(text) from public;
revoke all on function public.resolve_admin_token(text) from public;

grant execute on function public.keyflow_admin_change_password(text, text, text) to anon;
grant execute on function public.keyflow_admin_update_avatar(text, text) to anon;
grant execute on function public.keyflow_admin_update_display_name(text, text) to anon;
grant execute on function public.keyflow_admin_list(text) to anon;
grant execute on function public.keyflow_admin_create(text, text, text, text, text[]) to anon;
grant execute on function public.keyflow_admin_update_role(text, text, text, text[]) to anon;
grant execute on function public.keyflow_admin_delete(text, text) to anon;
grant execute on function public.keyflow_admin_reset_password(text, text, text) to anon;
grant execute on function public.keyflow_admin_answerer_summaries(text) to anon;
grant execute on function public.keyflow_admin_update_answerer_remark(text, uuid, text) to anon;
grant execute on function public.keyflow_admin_delete_answerer(text, uuid) to anon;
grant execute on function public.keyflow_admin_daily_questions(text) to anon;
grant execute on function public.keyflow_admin_create_daily_questions(text, jsonb) to anon;
grant execute on function public.keyflow_admin_process_daily_questions(text, uuid[]) to anon;
grant execute on function public.keyflow_admin_analytics_overview(text, text) to anon;
grant execute on function public.keyflow_review_password_reset(text, uuid, boolean, text) to anon, authenticated;
-- 登录 RPC 单独授权（因为是登录前置，单独重建一次怕之前 drop 掉了）
grant execute on function public.keyflow_admin_login(text, text) to anon, authenticated;
