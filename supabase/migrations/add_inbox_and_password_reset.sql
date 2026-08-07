-- 答主表增加头像字段
alter table public.keyflow_answerers add column if not exists avatar_url text not null default '';

-- 收件箱表
create table if not exists public.keyflow_inbox (
  id uuid primary key default gen_random_uuid(),
  type text not null default 'password_reset',
  title text not null,
  body text not null default '',
  from_id uuid references public.keyflow_answerers(id) on delete set null,
  status text not null default 'unread' check (status in ('unread', 'read', 'archived')),
  data jsonb default '{}',
  created_at timestamptz not null default now(),
  read_at timestamptz
);
create index if not exists keyflow_inbox_status_idx on public.keyflow_inbox(status);
alter table public.keyflow_inbox enable row level security;
create policy "keyflow public inbox access" on public.keyflow_inbox for all to anon, authenticated using (true) with check (true);

-- 密码重置申请表
create table if not exists public.keyflow_password_reset_requests (
  id uuid primary key default gen_random_uuid(),
  answerer_id uuid not null references public.keyflow_answerers(id) on delete cascade,
  inbox_id uuid references public.keyflow_inbox(id) on delete set null,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'completed')),
  admin_note text not null default '',
  requested_at timestamptz not null default now(),
  reviewed_at timestamptz,
  completed_at timestamptz
);
alter table public.keyflow_password_reset_requests enable row level security;
create policy "keyflow public password_reset access" on public.keyflow_password_reset_requests for all to anon, authenticated using (true) with check (true);

-- RPC: 答主申请重置密码
create or replace function public.keyflow_request_password_reset(p_answerer_id uuid)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_answerer record;
  v_existing uuid;
  v_inbox_id uuid;
  v_request_id uuid;
begin
  select id, zhihu_name into v_answerer from keyflow_answerers where id = p_answerer_id;
  if v_answerer.id is null then
    raise exception '答主不存在';
  end if;

  select id into v_existing from keyflow_password_reset_requests
  where answerer_id = p_answerer_id and status = 'pending';
  if v_existing is not null then
    raise exception '已有一个待处理的密码重置申请，请等待管理员审核';
  end if;

  insert into keyflow_inbox (type, title, body, from_id, data)
  values ('password_reset', v_answerer.zhihu_name || ' · 密码重置申请',
    '答主 ' || v_answerer.zhihu_name || ' 申请重置登录密码，请审核。',
    p_answerer_id,
    jsonb_build_object('answerer_name', v_answerer.zhihu_name, 'answerer_id', p_answerer_id))
  returning id into v_inbox_id;

  insert into keyflow_password_reset_requests (answerer_id, inbox_id)
  values (p_answerer_id, v_inbox_id)
  returning id into v_request_id;

  return json_build_object('request_id', v_request_id, 'inbox_id', v_inbox_id, 'status', 'pending');
end;
$$;
grant execute on function public.keyflow_request_password_reset(uuid) to anon, authenticated;

-- RPC: 管理员审核密码重置申请
create or replace function public.keyflow_review_password_reset(
  p_request_id uuid,
  p_approved boolean,
  p_note text default ''
)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_request record;
begin
  select * into v_request from keyflow_password_reset_requests where id = p_request_id;
  if v_request.id is null then
    raise exception '申请不存在';
  end if;
  if v_request.status != 'pending' then
    raise exception '该申请已被处理';
  end if;

  update keyflow_password_reset_requests
  set status = case when p_approved then 'approved' else 'rejected' end,
      admin_note = p_note,
      reviewed_at = now()
  where id = p_request_id;

  update keyflow_inbox set status = 'read', read_at = now()
  where id = v_request.inbox_id;

  return json_build_object(
    'request_id', p_request_id,
    'status', case when p_approved then 'approved' else 'rejected' end
  );
end;
$$;
grant execute on function public.keyflow_review_password_reset(uuid, boolean, text) to anon, authenticated;

-- RPC: 答主设置新密码（审核通过后）
create or replace function public.keyflow_reset_password(
  p_answerer_id uuid,
  p_new_password text
)
returns json
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_request record;
begin
  select * into v_request from keyflow_password_reset_requests
  where answerer_id = p_answerer_id and status = 'approved'
  order by reviewed_at desc limit 1;

  if v_request.id is null then
    raise exception '未找到已批准的密码重置申请';
  end if;

  update keyflow_answerers
  set password_hash = crypt(p_new_password, gen_salt('bf')), updated_at = now()
  where id = p_answerer_id;

  update keyflow_password_reset_requests
  set status = 'completed', completed_at = now()
  where id = v_request.id;

  return json_build_object('success', true);
end;
$$;
grant execute on function public.keyflow_reset_password(uuid, text) to anon, authenticated;

-- 更新登录 RPC：返回 avatar_url
create or replace function public.keyflow_login_answerer(
  p_zhihu_name text,
  p_password text
)
returns json
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_answerer record;
begin
  select id, zhihu_name, account_address, avatar_url, serial_number, created_at
  into v_answerer
  from keyflow_answerers
  where zhihu_name = p_zhihu_name
    and password_hash = crypt(p_password, password_hash);

  if v_answerer.id is null then
    raise exception '知乎用户名或密码错误';
  end if;

  return row_to_json(v_answerer);
end;
$$;
grant execute on function public.keyflow_login_answerer(text, text) to anon, authenticated;

-- 更新看板 RPC：返回 avatar_url
create or replace function public.keyflow_answerer_dashboard(p_answerer_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_answerer public.keyflow_answerers;
begin
  select * into v_answerer
  from public.keyflow_answerers
  where id = p_answerer_id;

  if v_answerer.id is null then
    raise exception '答主不存在';
  end if;

  return jsonb_build_object(
    'answerer', jsonb_build_object('id', v_answerer.id, 'zhihu_name', v_answerer.zhihu_name, 'avatar_url', v_answerer.avatar_url),
    'activities', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', a.id,
        'title', a.title,
        'game_name', a.game_name,
        'game_cover', a.game_cover,
        'status', a.status,
        'delivery_deadline', a.delivery_deadline,
        'application_status', app.status,
        'key_claimed', k.claimed_at is not null
      ) order by app.submitted_at desc)
      from public.keyflow_applications app
      join public.keyflow_activities a on a.id = app.activity_id
      left join public.keyflow_keys k on k.application_id = app.id
      left join public.keyflow_deliveries d on d.application_id = app.id
      where app.answerer_id = p_answerer_id and d.id is null
    ), '[]'::jsonb),
    'submissions', coalesce((
      select jsonb_agg(jsonb_build_object(
        'activity_id', a.id,
        'activity_title', a.title,
        'game_name', a.game_name,
        'article_url', d.article_url,
        'submitted_at', d.submitted_at
      ) order by d.submitted_at desc)
      from public.keyflow_applications app
      join public.keyflow_activities a on a.id = app.activity_id
      join public.keyflow_deliveries d on d.application_id = app.id
      where app.answerer_id = p_answerer_id
    ), '[]'::jsonb)
  );
end;
$$;
grant execute on function public.keyflow_answerer_dashboard(uuid) to anon, authenticated;
