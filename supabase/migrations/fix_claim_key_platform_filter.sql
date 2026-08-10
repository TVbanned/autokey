-- 修复 keyflow_claim_key：重新加入平台筛选（被 fix_claim_key_concurrency 覆盖丢失）
-- 同时添加平台库存查询函数供前端判断库存是否充足
drop function if exists public.keyflow_claim_key(uuid);

create or replace function public.keyflow_claim_key(p_application_id uuid)
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
    raise exception '该平台 Key 库存不足，请联系管理员';
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

-- 查询活动各平台 Key 库存（供前端判断库存是否充足）
drop function if exists public.keyflow_platform_stock(p_activity_id uuid);

create or replace function public.keyflow_platform_stock(p_activity_id uuid)
returns table(platform text, available bigint, total bigint)
language sql
security definer
set search_path = public
as $$
  select
    k.platform,
    count(*) filter (where k.application_id is null) as available,
    count(*) as total
  from keyflow_keys k
  where k.activity_id = p_activity_id
  group by k.platform
  order by k.platform;
$$;

grant execute on function public.keyflow_claim_key(uuid) to anon, authenticated;
grant execute on function public.keyflow_platform_stock(uuid) to anon, authenticated;
