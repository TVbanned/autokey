alter table public.keyflow_keys
  add column if not exists platform text not null default 'unknown'
  check (platform in ('steam', 'ubi', 'switch', 'ps5', 'unknown'));

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
    select trim(item->>'key_value') as key_value, item->>'platform' as platform
    from jsonb_array_elements(p_keys) as item
    where trim(item->>'key_value') <> ''
  ), inserted as (
    insert into keyflow_keys (activity_id, key_value, platform)
    select p_activity_id, key_value, platform from imported
    on conflict (activity_id, key_value) do nothing
    returning id
  )
  select count(*) into v_inserted_count from inserted;

  return query select v_inserted_count, v_total_count - v_inserted_count;
end;
$$;

grant execute on function public.keyflow_import_keys(uuid, jsonb) to anon, authenticated;
