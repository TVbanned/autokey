alter table public.keyflow_answerers
  add column if not exists dashboard_cover_url text;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('answerer-dashboard-covers', 'answerer-dashboard-covers', true, 819200, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "answerer dashboard covers public read" on storage.objects;
create policy "answerer dashboard covers public read"
  on storage.objects for select to public
  using (bucket_id = 'answerer-dashboard-covers');

drop policy if exists "answerer dashboard covers upload" on storage.objects;
create policy "answerer dashboard covers upload"
  on storage.objects for insert to anon, authenticated
  with check (bucket_id = 'answerer-dashboard-covers');

drop policy if exists "answerer dashboard covers update" on storage.objects;
create policy "answerer dashboard covers update"
  on storage.objects for update to anon, authenticated
  using (bucket_id = 'answerer-dashboard-covers')
  with check (bucket_id = 'answerer-dashboard-covers');

create or replace function public.keyflow_answerer_update_dashboard_cover(
  p_answerer_id uuid,
  p_dashboard_cover_url text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.keyflow_answerers
  set dashboard_cover_url = nullif(trim(p_dashboard_cover_url), ''), updated_at = now()
  where id = p_answerer_id;
end;
$$;

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
    'answerer', jsonb_build_object('id', v_answerer.id, 'zhihu_name', v_answerer.zhihu_name, 'avatar_url', v_answerer.avatar_url, 'dashboard_cover_url', v_answerer.dashboard_cover_url),
    'participated_count', (select count(distinct app.activity_id) from public.keyflow_applications app where app.answerer_id = p_answerer_id and app.status = 'selected'),
    'submission_count', (select count(*) from public.keyflow_applications app join public.keyflow_deliveries d on d.application_id = app.id where app.answerer_id = p_answerer_id),
    'daily_submission_count', (select count(*) from public.keyflow_daily_submissions where answerer_id = p_answerer_id),
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
      where app.answerer_id = p_answerer_id
        and d.id is null
        and app.status != 'rejected'
        and a.status != 'completed'
    ), '[]'::jsonb)
  );
end;
$$;

grant execute on function public.keyflow_answerer_update_dashboard_cover(uuid, text) to anon, authenticated;
grant execute on function public.keyflow_answerer_dashboard(uuid) to anon, authenticated;
