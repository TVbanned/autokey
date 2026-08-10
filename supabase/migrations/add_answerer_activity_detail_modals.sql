-- 答主看板：已完成活动 & 已参与活动 详情弹窗 RPC
create or replace function public.keyflow_answerer_completed_activities(p_answerer_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  return (
    select coalesce(jsonb_agg(entry order by latest_submitted_at desc), '[]'::jsonb)
    from (
      select
        a.id as activity_id,
        a.title as activity_title,
        a.game_name,
        a.game_cover,
        a.status as activity_status,
        jsonb_agg(jsonb_build_object(
          'delivery_id', d.id,
          'article_url', d.article_url,
          'article_title', d.article_title,
          'status', d.status,
          'submitted_at', d.submitted_at
        ) order by d.submitted_at desc) as deliveries,
        max(d.submitted_at) as latest_submitted_at
      from public.keyflow_applications app
      join public.keyflow_activities a on a.id = app.activity_id
      join public.keyflow_deliveries d on d.application_id = app.id
      where app.answerer_id = p_answerer_id
        and d.article_url is not null
      group by a.id, a.title, a.game_name, a.game_cover, a.status
    ) entry
  );
end;
$$;

grant execute on function public.keyflow_answerer_completed_activities(uuid) to anon, authenticated;

create or replace function public.keyflow_answerer_participated_activities(p_answerer_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  return (
    select coalesce(jsonb_agg(entry order by submitted_at desc), '[]'::jsonb)
    from (
      select
        a.id as activity_id,
        a.title as activity_title,
        a.game_name,
        a.game_cover,
        a.status as activity_status,
        app.status as application_status,
        app.submitted_at,
        exists(select 1 from public.keyflow_deliveries d where d.application_id = app.id) as has_delivery,
        k.claimed_at is not null as key_claimed
      from public.keyflow_applications app
      join public.keyflow_activities a on a.id = app.activity_id
      left join public.keyflow_keys k on k.application_id = app.id
      where app.answerer_id = p_answerer_id
        and app.status in ('selected', 'rejected')
    ) entry
  );
end;
$$;

grant execute on function public.keyflow_answerer_participated_activities(uuid) to anon, authenticated;
