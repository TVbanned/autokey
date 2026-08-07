-- 重新应用带日常投稿支持的看板 RPC（add_is_online_to_activities 覆盖了旧版）
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
    'participated_count', (select count(distinct app.activity_id) from public.keyflow_applications app where app.answerer_id = p_answerer_id),
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
      where app.answerer_id = p_answerer_id and d.id is null
    ), '[]'::jsonb),
    'more_activities', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', a.id,
        'title', a.title,
        'game_name', a.game_name,
        'game_cover', a.game_cover,
        'status', a.status,
        'delivery_deadline', a.delivery_deadline
      ) order by a.created_at desc)
      from public.keyflow_activities a
      where a.status not in ('draft', 'completed', 'key_distribution')
        and a.is_online = true
        and not exists (
          select 1
          from public.keyflow_applications app
          where app.activity_id = a.id and app.answerer_id = p_answerer_id
        )
    ), '[]'::jsonb),
    'submissions', (
      select coalesce(jsonb_agg(entry order by submitted_at desc), '[]'::jsonb)
      from (
        select jsonb_build_object(
          'type', 'activity',
          'activity_id', a.id,
          'activity_title', a.title,
          'game_name', a.game_name,
          'article_title', null,
          'article_url', d.article_url,
          'submitted_at', d.submitted_at
        ) as entry, d.submitted_at as submitted_at
        from public.keyflow_applications app
        join public.keyflow_activities a on a.id = app.activity_id
        join public.keyflow_deliveries d on d.application_id = app.id
        where app.answerer_id = p_answerer_id
        union all
        select jsonb_build_object(
          'type', 'daily',
          'activity_id', null,
          'activity_title', null,
          'game_name', null,
          'article_title', ds.article_title,
          'article_url', ds.article_url,
          'submitted_at', ds.submitted_at
        ) as entry, ds.submitted_at as submitted_at
        from public.keyflow_daily_submissions ds
        where ds.answerer_id = p_answerer_id
      ) combined
    )
  );
end;
$$;

grant execute on function public.keyflow_answerer_dashboard(uuid) to anon, authenticated;
