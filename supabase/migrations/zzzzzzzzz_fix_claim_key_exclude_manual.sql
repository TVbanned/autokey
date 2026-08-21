-- ponytail: 修复答主领取池误取已被管理员手动领取的 key。
-- 手动领取只写 claimed_at 而保留 application_id 为空，旧的 keyflow_claim_key
-- 仅按 application_id is null 选 key，导致这些 key 仍会被答主重复领取。
-- 这里补上 claimed_at is null，并同步修正库存统计口径。

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
    and k.claimed_at is null
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

create or replace function public.keyflow_platform_stock(p_activity_id uuid)
returns table(platform text, available bigint, total bigint)
language sql
security definer
set search_path = public
as $$
  select
    k.platform,
    count(*) filter (where k.application_id is null and k.claimed_at is null) as available,
    count(*) as total
  from keyflow_keys k
  where k.activity_id = p_activity_id
  group by k.platform
  order by k.platform;
$$;

grant execute on function public.keyflow_claim_key(uuid) to anon, authenticated;
grant execute on function public.keyflow_platform_stock(uuid) to anon, authenticated;
