-- 未识别格式的 Key 统一按 Steam 处理。
update public.keyflow_keys
set platform = 'steam'
where platform is null or trim(platform) = '' or platform = 'unknown';

alter table public.keyflow_keys
  alter column platform set default 'steam';

create or replace function public.keyflow_import_keys(p_activity_id uuid, p_keys jsonb)
returns table(inserted_count integer, duplicate_count integer)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_inserted_count integer;
  v_total_count integer;
begin
  if not exists (select 1 from keyflow_activities where id = p_activity_id) then
    raise exception '活动不存在';
  end if;

  select count(*) into v_total_count from jsonb_array_elements(p_keys);

  with imported as (
    select trim(item->>'key_value') as key_value, coalesce(nullif(item->>'platform', ''), 'steam') as platform
    from jsonb_array_elements(p_keys) as item
    where trim(item->>'key_value') <> ''
  ), inserted as (
    insert into keyflow_keys (activity_id, key_value, platform)
    select p_activity_id, key_value, case when platform = 'unknown' then 'steam' else platform end from imported
    on conflict (activity_id, key_value) do nothing
    returning id
  )
  select count(*) into v_inserted_count from inserted;

  return query select v_inserted_count, v_total_count - v_inserted_count;
end;
$$;

create or replace function public.keyflow_partner_import_keys(p_partner_token uuid, p_keys jsonb)
returns table(inserted_count integer, duplicate_count integer)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_activity_id uuid;
  v_inserted_count integer;
  v_total_count integer;
begin
  select id into v_activity_id
  from keyflow_activities
  where partner_token = p_partner_token;

  if v_activity_id is null then
    raise exception '合作方页面不存在或已失效';
  end if;

  select count(*) into v_total_count from jsonb_array_elements(p_keys);

  with imported as (
    select trim(item->>'key_value') as key_value, coalesce(nullif(item->>'platform', ''), 'steam') as platform
    from jsonb_array_elements(p_keys) as item
    where trim(item->>'key_value') <> ''
  ), inserted as (
    insert into keyflow_keys (activity_id, key_value, platform)
    select v_activity_id, key_value, case when platform = 'unknown' then 'steam' else platform end from imported
    on conflict (activity_id, key_value) do nothing
    returning id
  )
  select count(*) into v_inserted_count from inserted;

  return query select v_inserted_count, v_total_count - v_inserted_count;
end;
$$;
