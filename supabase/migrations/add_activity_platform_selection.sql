alter table public.keyflow_activities
  add column if not exists platforms text[] not null default array['steam'];

alter table public.keyflow_applications
  add column if not exists selected_platform text not null default 'steam';

do $$
declare
  constraint_name text;
begin
  for constraint_name in
    select conname
    from pg_constraint
    where conrelid = 'public.keyflow_keys'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) like '%platform%'
  loop
    execute format('alter table public.keyflow_keys drop constraint %I', constraint_name);
  end loop;
end;
$$;

alter table public.keyflow_keys
  add constraint keyflow_keys_platform_check
  check (platform in ('steam', 'ubi', 'switch', 'ps5', 'epic', 'unknown'));

drop function if exists public.keyflow_claim_key(uuid);
create function public.keyflow_claim_key(p_application_id uuid)
returns table(key_value text, claimed_at timestamptz)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_activity_id uuid;
  v_selected_platform text;
  v_key_id uuid;
begin
  select activity_id, coalesce(selected_platform, 'steam')
  into v_activity_id, v_selected_platform
  from keyflow_applications
  where id = p_application_id and status = 'selected'
  for update;

  if v_activity_id is null then
    raise exception '该答主尚未入选或不存在';
  end if;

  return query
  select k.key_value, k.claimed_at
  from keyflow_keys k
  where k.application_id = p_application_id;
  if found then
    return;
  end if;

  select k.id into v_key_id
  from keyflow_keys k
  where k.activity_id = v_activity_id
    and k.platform = v_selected_platform
    and k.application_id is null
  order by k.created_at
  for update skip locked
  limit 1;

  if v_key_id is null then
    raise exception '暂无可领取的对应版本 Key';
  end if;

  update keyflow_keys
  set application_id = p_application_id, claimed_at = now()
  where id = v_key_id;

  return query
  select k.key_value, k.claimed_at
  from keyflow_keys k
  where k.id = v_key_id;
end;
$$;

drop function if exists public.keyflow_register_with_code(uuid, text, text, text, text, integer);
create function public.keyflow_register_with_code(
  p_activity_id uuid,
  p_code text,
  p_zhihu_name text,
  p_wechat_name text,
  p_profile_url text,
  p_expected_word_count integer,
  p_selected_platform text
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
  if not exists (
    select 1
    from keyflow_activities
    where id = p_activity_id
      and coalesce(platforms, array['steam']) @> array[coalesce(p_selected_platform, 'steam')]
  ) then
    raise exception '所选版本不可用';
  end if;

  select id into v_code_id
  from keyflow_invitation_codes
  where upper(code) = upper(p_code)
    and application_id is null
    and answerer_id is null
  for update skip locked;

  if v_code_id is null then
    raise exception '邀请码无效或已被使用';
  end if;

  insert into keyflow_applications (
    activity_id, zhihu_name, wechat_name, profile_url,
    expected_word_count, selected_platform, status
  ) values (
    p_activity_id, p_zhihu_name, p_wechat_name, p_profile_url,
    greatest(p_expected_word_count, 800), coalesce(p_selected_platform, 'steam'), 'pending'
  ) returning id into v_app_id;

  update keyflow_invitation_codes
  set application_id = v_app_id, used_at = now()
  where id = v_code_id;

  select a.id, a.activity_id, a.zhihu_name, a.wechat_name, a.profile_url,
         a.expected_word_count, a.selected_platform, a.status, a.submitted_at, a.reviewer_note,
         a.zhihu_id, a.delayed_count
  into v_app
  from keyflow_applications a where a.id = v_app_id;

  return row_to_json(v_app);
end;
$$;

grant execute on function public.keyflow_claim_key(uuid) to anon, authenticated;
grant execute on function public.keyflow_register_with_code(uuid, text, text, text, text, integer, text) to anon, authenticated;
