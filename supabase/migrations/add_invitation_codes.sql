-- 邀请码表：一人一码，领 Key 的唯一凭证
create table if not exists public.keyflow_invitation_codes (
  id uuid primary key default gen_random_uuid(),
  activity_id uuid not null references public.keyflow_activities(id) on delete cascade,
  code text not null,
  application_id uuid unique references public.keyflow_applications(id) on delete set null,
  used_at timestamptz,
  created_at timestamptz not null default now(),
  unique (activity_id, code)
);

create index if not exists keyflow_invitation_codes_activity_idx
  on public.keyflow_invitation_codes(activity_id, application_id);

alter table public.keyflow_invitation_codes enable row level security;
create policy "keyflow public invitation access"
  on public.keyflow_invitation_codes for all to anon, authenticated
  using (true) with check (true);

-- RPC: 批量生成邀请码
create or replace function public.keyflow_generate_invitation_codes(
  p_activity_id uuid,
  p_count integer default 10
)
returns setof public.keyflow_invitation_codes
language plpgsql
security definer
set search_path = public
as $$
declare
  i integer;
  v_code text;
  v_id uuid;
  v_generated integer := 0;
begin
  for i in 1..p_count * 3 loop
    exit when v_generated >= p_count;
    v_code := 'KF-' || upper(substr(md5(gen_random_uuid()::text || clock_timestamp()::text), 1, 8));
    insert into keyflow_invitation_codes (activity_id, code)
    values (p_activity_id, v_code)
    on conflict (activity_id, code) do nothing
    returning id into v_id;
    if v_id is not null then
      v_generated := v_generated + 1;
      return query select * from keyflow_invitation_codes where id = v_id;
    end if;
  end loop;
end;
$$;

grant execute on function public.keyflow_generate_invitation_codes(uuid, integer) to anon, authenticated;

-- RPC: 邀请码注册（原子操作：验码 + 创建报名 + 绑定）
create or replace function public.keyflow_register_with_code(
  p_activity_id uuid,
  p_code text,
  p_zhihu_name text,
  p_wechat_name text,
  p_profile_url text,
  p_expected_word_count integer
)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_code_id uuid;
  v_app_id uuid;
  v_app record;
begin
  -- 原子检查并锁定邀请码
  select id into v_code_id
  from keyflow_invitation_codes
  where activity_id = p_activity_id
    and upper(code) = upper(p_code)
    and application_id is null
  for update skip locked;

  if v_code_id is null then
    raise exception '邀请码无效或已被使用';
  end if;

  -- 创建报名
  insert into keyflow_applications (
    activity_id, zhihu_name, wechat_name, profile_url,
    expected_word_count, status
  ) values (
    p_activity_id, p_zhihu_name, p_wechat_name, p_profile_url,
    greatest(p_expected_word_count, 800), 'pending'
  ) returning id into v_app_id;

  -- 绑定邀请码
  update keyflow_invitation_codes
  set application_id = v_app_id, used_at = now()
  where id = v_code_id;

  -- 返回报名数据（格式与前端 supabase.select 兼容）
  select a.id, a.activity_id, a.zhihu_name, a.wechat_name, a.profile_url,
         a.expected_word_count, a.status, a.submitted_at, a.reviewer_note,
         a.zhihu_id, a.delayed_count
  into v_app
  from keyflow_applications a where a.id = v_app_id;

  return row_to_json(v_app);
end;
$$;

grant execute on function public.keyflow_register_with_code(uuid, text, text, text, text, integer) to anon, authenticated;
