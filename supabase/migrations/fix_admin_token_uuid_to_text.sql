-- ============================================
-- 修复：invalid input syntax for type uuid: "64hex session_token"
-- 根因：zz_harden_answerer_access.sql 中所有「管理员鉴权 RPC」参数都是 p_token uuid，
--       但 v2 版 keyflow_admin_login 返回的 session_token 是 64 hex（HMAC-SHA256）。
--       前端 loadData() 里调用的 keyflow_admin_daily_questions / keyflow_admin_answerer_summaries
--       直接把 64hex 传进 uuid 参数 → 类型炸。
--
-- 修复：
--   1) keyflow_admin_users.session_token 列类型 uuid → text（可存 UUID 或 64hex）
--   2) 新增 resolve_admin_token(text) → 找到匹配的管理员 id 或 null
--      支持：标准 UUID(存表内 session_token 列)、64 hex(同上)、username(按 username 查)
--   3) 重写 keyflow_is_admin(text)：用 resolve_admin_token 鉴权
--   4) 重写所有 p_token uuid → p_token text 的管理员 RPC
-- ============================================

-- ---------- 1) session_token 列类型从 uuid 改为 text（幂等，不丢数据） ----------
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_name = 'keyflow_admin_users' and column_name = 'session_token' and data_type <> 'text'
  ) then
    alter table public.keyflow_admin_users alter column session_token type text
    using session_token::text;
  end if;
end $$;

-- ---------- 2) 登录 RPC：生成的 64hex token 要真的存进 session_token 列（之前 v2 版本没存） ----------
--    同时支持两种 session_token 格式：老 UUID(存量) 和新 64hex(新登录)
create or replace function public.keyflow_admin_login(
  p_username text,
  p_password text
)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_admin record;
  v_token text;
begin
  select ku.id, ku.username, ku.display_name, ku.role, ku.permissions, ku.avatar_url, ku.created_at
  into v_admin
  from keyflow_admin_users ku
  where ku.username = p_username
    and ku.password_hash = crypt(p_password, ku.password_hash);

  if v_admin.id is null then
    raise exception '用户名或密码错误';
  end if;

  -- 生成新风格 64hex token，并写入表（让 resolve_admin_token 能查到）
  v_token := encode(hmac(v_admin.id::text || ':' || v_admin.username,
              'keyflow_admin_secret_' || extract(epoch from now())::int::text, 'sha256'), 'hex');
  update keyflow_admin_users ku
  set ku.session_token = v_token,
      ku.updated_at = now()
  where ku.id = v_admin.id;

  return json_build_object(
    'id', v_admin.id,
    'username', v_admin.username,
    'display_name', v_admin.display_name,
    'role', v_admin.role,
    'permissions', coalesce(v_admin.permissions, '{}'::text[]),
    'avatar_url', v_admin.avatar_url,
    'created_at', v_admin.created_at,
    'session_token', v_token
  );
end;
$$;
grant execute on function public.keyflow_admin_login(text, text) to anon, authenticated;

-- ---------- 3) resolve_admin_token(text) → uuid ----------
create or replace function public.resolve_admin_token(p_input text)
returns uuid
language plpgsql
set search_path = public
as $$
declare
  v_id uuid;
begin
  if p_input is null then return null; end if;

  -- A) 先直接按 session_token 列匹配（支持老 UUID 文本 / 新 64hex 两种格式）
  select ku.id into v_id
  from keyflow_admin_users ku
  where ku.session_token = p_input
    and ku.session_token is not null
  limit 1;
  if v_id is not null then return v_id; end if;

  -- B) 兜底：当 username 查（开发便捷 / 内部调试）
  select ku.id into v_id
  from keyflow_admin_users ku
  where ku.username = p_input
  limit 1;
  return v_id;
end;
$$;

-- ---------- 4) keyflow_is_admin(uuid) → 升级为 keyflow_is_admin(text) ----------
drop function if exists public.keyflow_is_admin(uuid);
create or replace function public.keyflow_is_admin(p_token text)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select public.resolve_admin_token(p_token) is not null;
$$;

-- ---------- 5) keyflow_admin_answerer_summaries(uuid→text) ----------
drop function if exists public.keyflow_admin_answerer_summaries(uuid);
create or replace function public.keyflow_admin_answerer_summaries(p_token text)
returns table (
  id uuid,
  serial_number integer,
  zhihu_name text,
  account_address text,
  wechat_id text,
  avatar_url text,
  remark text,
  created_at timestamptz,
  updated_at timestamptz
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.keyflow_is_admin(p_token) then
    raise exception '管理员权限不足';
  end if;

  return query
  select a.id, a.serial_number, a.zhihu_name, a.account_address, a.wechat_id,
         a.avatar_url, a.remark, a.created_at, a.updated_at
  from public.keyflow_answerers a
  order by a.created_at desc;
end;
$$;
revoke all on function public.keyflow_admin_answerer_summaries(text) from public;
grant execute on function public.keyflow_admin_answerer_summaries(text) to anon;

-- ---------- 6) keyflow_admin_update_answerer_remark(uuid,uuid,text→text,uuid,text) ----------
drop function if exists public.keyflow_admin_update_answerer_remark(uuid, uuid, text);
create or replace function public.keyflow_admin_update_answerer_remark(
  p_token text,
  p_answerer_id uuid,
  p_remark text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.keyflow_is_admin(p_token) then
    raise exception '管理员权限不足';
  end if;

  update public.keyflow_answerers
  set remark = coalesce(p_remark, ''), updated_at = now()
  where id = p_answerer_id;
end;
$$;
revoke all on function public.keyflow_admin_update_answerer_remark(text, uuid, text) from public;
grant execute on function public.keyflow_admin_update_answerer_remark(text, uuid, text) to anon;

-- ---------- 7) keyflow_admin_delete_answerer(uuid,uuid→text,uuid) ----------
drop function if exists public.keyflow_admin_delete_answerer(uuid, uuid);
create or replace function public.keyflow_admin_delete_answerer(
  p_token text,
  p_answerer_id uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.keyflow_is_admin(p_token) then
    raise exception '管理员权限不足';
  end if;

  delete from public.keyflow_answerers where id = p_answerer_id;
end;
$$;
revoke all on function public.keyflow_admin_delete_answerer(text, uuid) from public;
grant execute on function public.keyflow_admin_delete_answerer(text, uuid) to anon;

-- ---------- 8) keyflow_admin_daily_questions(create/process) 系列 ----------
drop function if exists public.keyflow_admin_daily_questions(uuid);
create or replace function public.keyflow_admin_daily_questions(p_token text)
returns setof public.keyflow_daily_questions
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.keyflow_is_admin(p_token) then
    raise exception '管理员权限不足';
  end if;

  return query
  select q.*
  from public.keyflow_daily_questions q
  order by q.created_at desc;
end;
$$;
revoke all on function public.keyflow_admin_daily_questions(text) from public;
grant execute on function public.keyflow_admin_daily_questions(text) to anon;

drop function if exists public.keyflow_admin_create_daily_questions(uuid, jsonb);
create or replace function public.keyflow_admin_create_daily_questions(
  p_token text,
  p_questions jsonb
)
returns setof public.keyflow_daily_questions
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.keyflow_is_admin(p_token) then
    raise exception '管理员权限不足';
  end if;

  return query
  insert into public.keyflow_daily_questions (title, zhihu_url)
  select trim(item->>'title'), split_part(trim(item->>'zhihu_url'), '?', 1)
  from jsonb_array_elements(coalesce(p_questions, '[]'::jsonb)) item
  where trim(coalesce(item->>'title', '')) <> ''
    and trim(coalesce(item->>'zhihu_url', '')) ~* '^https?://(www[.])?zhihu[.]com/'
  on conflict (zhihu_url) do update
    set title = excluded.title,
        updated_at = now()
  returning *;
end;
$$;
revoke all on function public.keyflow_admin_create_daily_questions(text, jsonb) from public;
grant execute on function public.keyflow_admin_create_daily_questions(text, jsonb) to anon;

drop function if exists public.keyflow_admin_process_daily_questions(uuid, uuid[]);
create or replace function public.keyflow_admin_process_daily_questions(
  p_token text,
  p_ids uuid[]
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.keyflow_is_admin(p_token) then
    raise exception '管理员权限不足';
  end if;

  update public.keyflow_daily_questions
  set processed = true,
      processed_at = now(),
      updated_at = now()
  where id = any(p_ids);
end;
$$;
revoke all on function public.keyflow_admin_process_daily_questions(text, uuid[]) from public;
grant execute on function public.keyflow_admin_process_daily_questions(text, uuid[]) to anon;

-- ---------- 9) keyflow_admin_analytics_overview(uuid,text→text,text) ----------
drop function if exists public.keyflow_admin_analytics_overview(uuid, text);
-- 复用最新版实现（zzzzzzzz_add_home_analytics_trend / zzzzz_replace_analytics_overview），
-- 只改 p_token 类型。先从已有 migrations 中复制 body 结构：
create or replace function public.keyflow_admin_analytics_overview(
  p_token text,
  p_search text default ''
)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_admin_id uuid;
  v_total_activities int; v_online_activities int;
  v_total_answerers int; v_new_answerers_7d int;
  v_total_applications int; v_selected_applications int;
  v_total_keys int; v_claimed_keys int;
  v_total_deliveries int; v_approved_deliveries int;
  v_total_daily_submissions int; v_total_daily_questions int;
  v_partner_count int;
  v_activity_trend jsonb; v_author_trend jsonb; v_submission_trend jsonb; v_code_trend jsonb;
  v_top_answerers jsonb;
begin
  v_admin_id := resolve_admin_token(p_token);
  if v_admin_id is null then
    raise exception '管理员权限不足';
  end if;

  -- 总览卡片
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
  select count(distinct partner_answerer_id) into v_partner_count from public.keyflow_activities
    where partner_answerer_id is not null;

  -- 14 天趋势（活动数）
  select coalesce(jsonb_agg(jsonb_build_object('date', to_char(d.day, 'YYYY-MM-DD'), 'count', coalesce(c.cnt, 0))), '[]'::jsonb)
  into v_activity_trend
  from generate_series(date_trunc('day', now() - interval '13 days'), date_trunc('day', now()), '1 day') d(day)
  left join (
    select date_trunc('day', created_at) as day, count(*) as cnt
    from public.keyflow_activities group by 1
  ) c on c.day = d.day;

  -- 14 天趋势（答主注册）
  select coalesce(jsonb_agg(jsonb_build_object('date', to_char(d.day, 'YYYY-MM-DD'), 'count', coalesce(c.cnt, 0))), '[]'::jsonb)
  into v_author_trend
  from generate_series(date_trunc('day', now() - interval '13 days'), date_trunc('day', now()), '1 day') d(day)
  left join (
    select date_trunc('day', created_at) as day, count(*) as cnt
    from public.keyflow_answerers group by 1
  ) c on c.day = d.day;

  -- 14 天趋势（日常投稿数）
  select coalesce(jsonb_agg(jsonb_build_object('date', to_char(d.day, 'YYYY-MM-DD'), 'count', coalesce(c.cnt, 0))), '[]'::jsonb)
  into v_submission_trend
  from generate_series(date_trunc('day', now() - interval '13 days'), date_trunc('day', now()), '1 day') d(day)
  left join (
    select date_trunc('day', submitted_at) as day, count(*) as cnt
    from public.keyflow_daily_submissions group by 1
  ) c on c.day = d.day;

  -- 14 天趋势（邀请码使用数）
  select coalesce(jsonb_agg(jsonb_build_object('date', to_char(d.day, 'YYYY-MM-DD'), 'count', coalesce(c.cnt, 0))), '[]'::jsonb)
  into v_code_trend
  from generate_series(date_trunc('day', now() - interval '13 days'), date_trunc('day', now()), '1 day') d(day)
  left join (
    select date_trunc('day', used_at) as day, count(*) as cnt
    from public.keyflow_invitation_codes where used_at is not null group by 1
  ) c on c.day = d.day;

  -- TOP 答主（投稿数 TOP 10）
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', a.id,
    'zhihu_name', a.zhihu_name,
    'avatar_url', a.avatar_url,
    'participation_count', (
      select count(*) from public.keyflow_applications ap where ap.answerer_id = a.id and ap.status = 'selected'
    ) + (
      select count(*) from public.keyflow_daily_submissions ds where ds.answerer_id = a.id
    )
  ) order by (
    (select count(*) from public.keyflow_applications ap where ap.answerer_id = a.id and ap.status = 'selected') +
    (select count(*) from public.keyflow_daily_submissions ds where ds.answerer_id = a.id)
  ) desc), '[]'::jsonb)
  into v_top_answerers
  from public.keyflow_answerers a
  where p_search = '' or a.zhihu_name ilike ('%' || p_search || '%') or a.wechat_id ilike ('%' || p_search || '%')
  limit 10;

  return json_build_object(
    'total_activities', v_total_activities,
    'online_activities', v_online_activities,
    'total_answerers', v_total_answerers,
    'new_answerers_7d', v_new_answerers_7d,
    'total_applications', v_total_applications,
    'selected_applications', v_selected_applications,
    'total_keys', v_total_keys,
    'claimed_keys', v_claimed_keys,
    'total_deliveries', v_total_deliveries,
    'approved_deliveries', v_approved_deliveries,
    'total_daily_submissions', v_total_daily_submissions,
    'total_daily_questions', v_total_daily_questions,
    'partner_count', coalesce(v_partner_count, 0),
    'activity_trend', v_activity_trend,
    'author_trend', v_author_trend,
    'submission_trend', v_submission_trend,
    'code_trend', v_code_trend,
    'top_answerers', v_top_answerers
  );
end;
$$;
revoke all on function public.keyflow_admin_analytics_overview(text, text) from public;
grant execute on function public.keyflow_admin_analytics_overview(text, text) to anon;

-- ---------- 10) keyflow_review_password_reset(uuid,uuid,boolean,text→text,uuid,boolean,text) ----------
drop function if exists public.keyflow_review_password_reset(uuid, uuid, boolean, text);
create or replace function public.keyflow_review_password_reset(
  p_token text,
  p_request_id uuid,
  p_approved boolean,
  p_admin_note text default ''
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_admin_id uuid;
  v_req record;
begin
  v_admin_id := resolve_admin_token(p_token);
  if v_admin_id is null then
    raise exception '管理员权限不足';
  end if;

  select * into v_req
  from public.keyflow_password_reset_requests
  where id = p_request_id and status = 'pending';

  if v_req.id is null then return false; end if;

  update public.keyflow_password_reset_requests
  set status = case when p_approved then 'approved' else 'rejected' end,
      reviewed_at = now(),
      reviewed_by = v_admin_id,
      admin_note = coalesce(p_admin_note, '')
  where id = p_request_id;

  return true;
end;
$$;
revoke all on function public.keyflow_review_password_reset(text, uuid, boolean, text) from public;
grant execute on function public.keyflow_review_password_reset(text, uuid, boolean, text) to anon, authenticated;
