-- 数据概览 RPC 新增 answerer_levels：
-- 全部答主的全量积分统计（参与/交付/日常投稿），用于管理端「当前积分等级」列与「等级一览」页卡
drop function if exists public.keyflow_admin_analytics_overview(uuid, text) cascade;
drop function if exists public.keyflow_admin_analytics_overview(text, text) cascade;

create or replace function public.keyflow_admin_analytics_overview(
  p_token text,
  p_search text default ''
)
returns json
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_admin_id uuid;
  v_result json;
begin
  v_admin_id := resolve_admin_token(p_token);
  if v_admin_id is null then
    raise exception '管理员权限不足';
  end if;

  select json_build_object(
    'home_total', coalesce((
      select json_build_object(
        'pv', count(*)::integer,
        'uv', count(distinct visitor_id)::integer
      )
      from public.keyflow_page_views
      where page_type = 'home' and viewed_at >= current_date - interval '29 days'
    ), json_build_object('pv', 0, 'uv', 0)),
    'home_daily', coalesce((
      select json_agg(row_to_json(d) order by d.day)
      from (
        select days.day::date as day,
          count(v.id)::integer as pv,
          count(distinct v.visitor_id)::integer as uv
        from generate_series(current_date - interval '29 days', current_date, interval '1 day') as days(day)
        left join public.keyflow_page_views v
          on v.page_type = 'home'
          and v.viewed_at >= days.day
          and v.viewed_at < days.day + interval '1 day'
        group by days.day
      ) d
    ), '[]'::json),
    'claim_heatmap', coalesce((
      select json_agg(row_to_json(d) order by d.game_name, d.day)
      from (
        select activity.id as activity_id, activity.title as activity_title,
          activity.game_name, days.day::date as day,
          count(v.id)::integer as page_views
        from public.keyflow_activities activity
        cross join generate_series(current_date - interval '29 days', current_date, interval '1 day') as days(day)
        left join public.keyflow_page_views v
          on v.activity_id = activity.id
          and v.page_type = 'claim'
          and v.viewed_at >= days.day
          and v.viewed_at < days.day + interval '1 day'
        group by activity.id, activity.title, activity.game_name, days.day
      ) d
    ), '[]'::json),
    'user_activity', coalesce((
      select json_agg(row_to_json(u) order by u.score desc, u.last_activity desc)
      from (
        with page_events as (
          select v.answerer_id, count(*)::integer as page_views,
            count(distinct v.viewed_at::date)::integer as page_active_days,
            max(v.viewed_at) as last_page_view
          from public.keyflow_page_views v
          where v.answerer_id is not null and v.viewed_at >= current_date - interval '29 days'
          group by v.answerer_id
        ), applications as (
          select app.answerer_id, count(*)::integer as applications,
            count(distinct app.submitted_at::date)::integer as application_active_days,
            max(app.submitted_at) as last_application
          from public.keyflow_applications app
          where app.answerer_id is not null and app.submitted_at >= current_date - interval '29 days'
          group by app.answerer_id
        ), claimed_keys as (
          select app.answerer_id, count(k.id)::integer as claimed_keys,
            count(distinct k.claimed_at::date)::integer as key_active_days,
            max(k.claimed_at) as last_key_claim
          from public.keyflow_keys k
          join public.keyflow_applications app on app.id = k.application_id
          where app.answerer_id is not null and k.claimed_at >= current_date - interval '29 days'
          group by app.answerer_id
        ), deliveries as (
          select app.answerer_id, count(d.id)::integer as deliveries,
            max(d.submitted_at) as last_delivery
          from public.keyflow_deliveries d
          join public.keyflow_applications app on app.id = d.application_id
          where app.answerer_id is not null and d.submitted_at >= current_date - interval '29 days'
          group by app.answerer_id
        ), active_days as (
          select answerer_id, count(distinct activity_day)::integer as active_days,
            array_agg(distinct activity_day order by activity_day) as active_dates
          from (
            select answerer_id, viewed_at::date as activity_day from public.keyflow_page_views where answerer_id is not null and viewed_at >= current_date - interval '29 days'
            union all
            select answerer_id, submitted_at::date from public.keyflow_applications where answerer_id is not null and submitted_at >= current_date - interval '29 days'
            union all
            select app.answerer_id, k.claimed_at::date from public.keyflow_keys k join public.keyflow_applications app on app.id = k.application_id where app.answerer_id is not null and k.claimed_at >= current_date - interval '29 days'
            union all
            select app.answerer_id, d.submitted_at::date from public.keyflow_deliveries d join public.keyflow_applications app on app.id = d.application_id where app.answerer_id is not null and d.submitted_at >= current_date - interval '29 days'
          ) activity_events
          group by answerer_id
        )
        select a.id, a.zhihu_name, a.account_address,
          coalesce(pe.page_views, 0) as page_views,
          coalesce(ap.applications, 0) as applications,
          coalesce(ck.claimed_keys, 0) as claimed_keys,
          coalesce(dl.deliveries, 0) as deliveries,
          coalesce(ad.active_days, 0) as active_days,
          coalesce(ad.active_dates, '{}'::date[]) as active_dates,
          (coalesce(pe.page_views, 0) + coalesce(ap.applications, 0) * 3 + coalesce(dl.deliveries, 0) * 8)::integer as score,
          greatest(pe.last_page_view, ap.last_application, ck.last_key_claim, dl.last_delivery) as last_activity,
          jsonb_build_array(
            jsonb_build_object('label', '页面访问', 'count', coalesce(pe.page_views, 0)),
            jsonb_build_object('label', '报名', 'count', coalesce(ap.applications, 0)),
            jsonb_build_object('label', '领取 Key', 'count', coalesce(ck.claimed_keys, 0)),
            jsonb_build_object('label', '交付', 'count', coalesce(dl.deliveries, 0))
          ) as event_labels
        from public.keyflow_answerers a
        left join page_events pe on pe.answerer_id = a.id
        left join applications ap on ap.answerer_id = a.id
        left join claimed_keys ck on ck.answerer_id = a.id
        left join deliveries dl on dl.answerer_id = a.id
        left join active_days ad on ad.answerer_id = a.id
        where (pe.answerer_id is not null or ap.answerer_id is not null or ck.answerer_id is not null or dl.answerer_id is not null)
          and (coalesce(p_search, '') = '' or a.zhihu_name ilike '%' || p_search || '%' or a.account_address ilike '%' || p_search || '%')
      ) u
    ), '[]'::json),
    'answerer_levels', coalesce((
      select json_agg(row_to_json(l) order by l.points desc, l.zhihu_name)
      from (
        select a.id, a.zhihu_name, a.account_address, a.avatar_url,
          coalesce(p.cnt, 0)::integer as participated_count,
          coalesce(s.cnt, 0)::integer as submission_count,
          coalesce(ds.cnt, 0)::integer as daily_submission_count,
          (coalesce(p.cnt, 0) * 50 + coalesce(s.cnt, 0) * 300 + coalesce(ds.cnt, 0) * 80)::integer as points
        from public.keyflow_answerers a
        left join (
          select answerer_id, count(distinct activity_id) as cnt
          from public.keyflow_applications
          where status = 'selected'
          group by answerer_id
        ) p on p.answerer_id = a.id
        left join (
          select app.answerer_id, count(*) as cnt
          from public.keyflow_applications app
          join public.keyflow_deliveries d on d.application_id = app.id
          group by app.answerer_id
        ) s on s.answerer_id = a.id
        left join (
          select answerer_id, count(*) as cnt
          from public.keyflow_daily_submissions
          group by answerer_id
        ) ds on ds.answerer_id = a.id
      ) l
    ), '[]'::json)
  ) into v_result;

  return v_result;
end;
$$;

revoke all on function public.keyflow_admin_analytics_overview(text, text) from public;
grant execute on function public.keyflow_admin_analytics_overview(text, text) to anon;
