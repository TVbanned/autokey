-- 同步管理员头像 = 对应答主头像（匹配 keyflow_admin_users.username = keyflow_answerers.zhihu_name）
-- 需求：灰域信风、admin（如果有对应的答主账号）管理员头像=答主头像，保持一致。

-- 1) 先一次性同步所有匹配上的管理员
update keyflow_admin_users ku
set avatar_url = a.avatar_url,
    updated_at = now()
from keyflow_answerers a
where ku.username = a.zhihu_name
  and a.avatar_url is not null
  and (ku.avatar_url is null or ku.avatar_url <> a.avatar_url);

-- 2) 重写 keyflow_admin_login：每次登录时，自动把答主头像同步过来（长期保持一致）
create extension if not exists pgcrypto;
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
  v_answerer_avatar text;
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

  -- 自动同步答主头像 -> 管理员头像
  select a.avatar_url into v_answerer_avatar
  from keyflow_answerers a
  where a.zhihu_name = v_admin.username
    and a.avatar_url is not null
  limit 1;

  if v_answerer_avatar is not null and (v_admin.avatar_url is null or v_admin.avatar_url <> v_answerer_avatar) then
    v_admin.avatar_url := v_answerer_avatar;
    update keyflow_admin_users
    set avatar_url = v_answerer_avatar,
        updated_at = now()
    where id = v_admin.id;
  end if;

  -- token 存 username，兼容 PHP 端 media-upload.php 里直接 where session_token = token 的老 SQL
  v_token := v_admin.username;
  update keyflow_admin_users
  set session_token = v_token,
      updated_at = now()
  where id = v_admin.id;

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

-- 3) 重写 keyflow_admin_login_as_username：每次免密登录也自动同步答主头像
create or replace function public.keyflow_admin_login_as_username(
  p_username text
)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_admin record;
  v_answerer_avatar text;
  v_token text;
begin
  if p_username not in ('admin', '灰域信风') then
    raise exception '无权免密登录';
  end if;

  select ku.id, ku.username, ku.display_name, ku.role, ku.permissions, ku.avatar_url, ku.created_at
  into v_admin
  from keyflow_admin_users ku
  where ku.username = p_username;

  if v_admin.id is null then
    raise exception '管理员账号不存在';
  end if;

  -- 自动同步答主头像 -> 管理员头像
  select a.avatar_url into v_answerer_avatar
  from keyflow_answerers a
  where a.zhihu_name = v_admin.username
    and a.avatar_url is not null
  limit 1;

  if v_answerer_avatar is not null and (v_admin.avatar_url is null or v_admin.avatar_url <> v_answerer_avatar) then
    v_admin.avatar_url := v_answerer_avatar;
    update keyflow_admin_users
    set avatar_url = v_answerer_avatar,
        updated_at = now()
    where id = v_admin.id;
  end if;

  v_token := v_admin.username;
  update keyflow_admin_users
  set session_token = v_token,
      updated_at = now()
  where id = v_admin.id;

  return json_build_object(
    'id', v_admin.id,
    'username', v_admin.username,
    'display_name', v_admin.display_name,
    'role', coalesce(v_admin.role, 'super_admin'),
    'permissions', coalesce(v_admin.permissions,
      array['activity_manage','application_review','key_manage','delivery_review','answerer_manage','partner_manage','daily_question_manage','page_edit','inbox_private_message','data_overview']::text[]),
    'avatar_url', v_admin.avatar_url,
    'created_at', v_admin.created_at,
    'session_token', v_token
  );
end;
$$;
revoke all on function public.keyflow_admin_login_as_username(text) from public;
grant execute on function public.keyflow_admin_login_as_username(text) to anon, authenticated;
