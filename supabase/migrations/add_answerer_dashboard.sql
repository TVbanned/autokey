alter table public.keyflow_applications
  add column if not exists answerer_id uuid references public.keyflow_answerers(id) on delete set null;

create index if not exists keyflow_applications_answerer_id_idx
  on public.keyflow_applications(answerer_id);

update public.keyflow_applications a
set answerer_id = answerer.id
from public.keyflow_answerers answerer
where a.answerer_id is null
  and a.zhihu_name = answerer.zhihu_name
  and nullif(a.profile_url, '') is not null
  and a.profile_url = answerer.account_address;

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
    'answerer', jsonb_build_object('id', v_answerer.id, 'zhihu_name', v_answerer.zhihu_name),
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