alter table public.keyflow_activities
  add column if not exists partner_token uuid not null default gen_random_uuid();

create unique index if not exists keyflow_activities_partner_token_idx
  on public.keyflow_activities(partner_token);

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
    select trim(item->>'key_value') as key_value, item->>'platform' as platform
    from jsonb_array_elements(p_keys) as item
    where trim(item->>'key_value') <> ''
  ), inserted as (
    insert into keyflow_keys (activity_id, key_value, platform)
    select v_activity_id, key_value, platform from imported
    on conflict (activity_id, key_value) do nothing
    returning id
  )
  select count(*) into v_inserted_count from inserted;

  return query select v_inserted_count, v_total_count - v_inserted_count;
end;
$$;

grant execute on function public.keyflow_partner_import_keys(uuid, jsonb) to anon, authenticated;

create or replace function public.keyflow_partner_activity_snapshot(p_partner_token uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_activity keyflow_activities;
begin
  select * into v_activity from keyflow_activities where partner_token = p_partner_token;
  if v_activity.id is null then
    raise exception '合作方页面不存在或已失效';
  end if;

  return jsonb_build_object(
    'activity', jsonb_build_object('title', v_activity.title, 'game_name', v_activity.game_name, 'game_cover', v_activity.game_cover, 'application_deadline', v_activity.application_deadline, 'delivery_deadline', v_activity.delivery_deadline),
    'applications', coalesce((select jsonb_agg(jsonb_build_object('zhihu_name', a.zhihu_name, 'status', a.status, 'submitted_at', a.submitted_at) order by a.submitted_at desc) from keyflow_applications a where a.activity_id = v_activity.id), '[]'::jsonb),
    'deliveries', coalesce((select jsonb_agg(jsonb_build_object('zhihu_name', a.zhihu_name, 'status', d.status, 'article_url', d.article_url, 'submitted_at', d.submitted_at) order by d.submitted_at desc) from keyflow_deliveries d join keyflow_applications a on a.id = d.application_id where a.activity_id = v_activity.id), '[]'::jsonb),
    'key_count', (select count(*) from keyflow_keys where activity_id = v_activity.id)
  );
end;
$$;

grant execute on function public.keyflow_partner_activity_snapshot(uuid) to anon, authenticated;
