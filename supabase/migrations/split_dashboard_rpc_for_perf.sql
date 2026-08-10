-- 拆分看板 RPC：核心数据快速返回，次要数据延迟加载，提升首屏速度
-- 核心 RPC：只查 answerer + 计数 + 进行中活动（快速）
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
    'answerer', jsonb_build_object('id', v_answerer.id, 'zhihu_name', v_answerer.zhihu_name, 'avatar_url', v_answerer.avatar_url),
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

-- 扩展数据 RPC：更多活动 + 历史活动 + 作品列表（延迟加载）
create or replace function public.keyflow_answerer_dashboard_extras(p_answerer_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  return jsonb_build_object(
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
      where a.status = 'recruiting'
        and a.is_online = true
        and not exists (
          select 1
          from public.keyflow_applications app
          where app.activity_id = a.id and app.answerer_id = p_answerer_id
        )
    ), '[]'::jsonb),
    'historical_activities', coalesce((
      select jsonb_agg(entry order by created_at desc)
      from (
        select jsonb_build_object(
          'id', a.id,
          'title', a.title,
          'game_name', a.game_name,
          'game_cover', a.game_cover,
          'status', a.status,
          'delivery_deadline', a.delivery_deadline,
          'application_status', app.status
        ) as entry, a.created_at as created_at
        from public.keyflow_activities a
        left join public.keyflow_applications app
          on app.activity_id = a.id and app.answerer_id = p_answerer_id
        where (a.is_online = true or app.id is not null)
          and a.status not in ('draft', 'recruiting')
          and (
            a.status = 'completed'
            or app.id is null
            or app.status = 'rejected'
            or not exists (
              select 1
              from public.keyflow_applications selected_app
              where selected_app.activity_id = a.id
                and selected_app.answerer_id = p_answerer_id
                and selected_app.status = 'selected'
            )
          )

        union all

        select jsonb_build_object(
          'id', a.id,
          'title', a.title,
          'game_name', a.game_name,
          'game_cover', a.game_cover,
          'status', a.status,
          'delivery_deadline', a.delivery_deadline,
          'application_status', app.status
        ) as entry, coalesce(app.reviewed_at, a.created_at) as created_at
        from public.keyflow_applications app
        join public.keyflow_activities a on a.id = app.activity_id
        where app.answerer_id = p_answerer_id
          and app.status = 'rejected'
          and a.status = 'recruiting'
          and (a.is_online = true or app.id is not null)
      ) combined
    ), '[]'::jsonb),
    'submissions', coalesce((
      select jsonb_agg(entry order by submitted_at desc)
      from (
        select entry, submitted_at
        from (
          select jsonb_build_object(
            'type', 'activity',
            'activity_id', a.id,
            'activity_title', a.title,
            'game_name', a.game_name,
            'article_title', d.article_title,
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
        order by submitted_at desc
        limit 100
      ) recent_submissions
    ), '[]'::jsonb)
  );
end;
$$;

grant execute on function public.keyflow_answerer_dashboard(uuid) to anon, authenticated;
grant execute on function public.keyflow_answerer_dashboard_extras(uuid) to anon, authenticated;
