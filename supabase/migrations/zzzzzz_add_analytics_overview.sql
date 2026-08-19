-- 页面访问统计：从本 migration 执行日起开始累积。
create table if not exists public.keyflow_page_views (
  id bigint generated always as identity primary key,
  page_type text not null check (page_type in ('home', 'claim')),
  activity_id uuid references public.keyflow_activities(id) on delete cascade,
  answerer_id uuid references public.keyflow_answerers(id) on delete set null,
  visitor_id uuid not null,
  viewed_at timestamptz not null default now()
);

create index if not exists keyflow_page_views_page_date_idx
  on public.keyflow_page_views (page_type, viewed_at desc);
create index if not exists keyflow_page_views_activity_date_idx
  on public.keyflow_page_views (activity_id, viewed_at desc);
create index if not exists keyflow_page_views_answerer_date_idx
  on public.keyflow_page_views (answerer_id, viewed_at desc);

alter table public.keyflow_page_views enable row level security;

create or replace function public.keyflow_track_page_view(
  p_page_type text,
  p_activity_id uuid,
  p_answerer_id uuid,
  p_visitor_id uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.keyflow_page_views (page_type, activity_id, answerer_id, visitor_id)
  values (p_page_type, p_activity_id, p_answerer_id, p_visitor_id);
end;
$$;

create or replace function public.keyflow_admin_analytics_overview(
  p_token uuid,
  p_search text default ''
)
returns json
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_result json;
begin
  if not public.keyflow_is_admin(p_token) then
    raise exception '管理员权限不足';
  end if;

  select json_build_object(
    'home_daily', coalesce((
      select json_agg(row_to_json(d) order by d.day)
      from (
        select viewed_at::date as day, count(*)::integer as pv, count(distinct visitor_id)::integer as uv
        from public.keyflow_page_views
        where page_type = 'home' and viewed_at >= current_date - interval '29 days'
        group by viewed_at::date
      ) d
    ), '[]'::json),
    'claim_pages', coalesce((
      select json_agg(row_to_json(c) order by c.pv desc, c.game_name)
      from (
        select a.id, a.title, a.game_name, count(v.id)::integer as pv, count(distinct v.visitor_id)::integer as uv
        from public.keyflow_activities a
        left join public.keyflow_page_views v on v.activity_id = a.id and v.page_type = 'claim'
        group by a.id, a.title, a.game_name
      ) c
    ), '[]'::json),
    'users', coalesce((
      select json_agg(row_to_json(u) order by u.visit_count desc, u.last_active_at desc)
      from (
        select a.id, a.zhihu_name, a.account_address, count(v.id)::integer as visit_count,
          count(distinct v.viewed_at::date)::integer as active_days, max(v.viewed_at) as last_active_at
        from public.keyflow_answerers a
        join public.keyflow_page_views v on v.answerer_id = a.id
        where coalesce(p_search, '') = ''
          or a.zhihu_name ilike '%' || p_search || '%'
          or a.account_address ilike '%' || p_search || '%'
        group by a.id, a.zhihu_name, a.account_address
      ) u
    ), '[]'::json)
  ) into v_result;

  return v_result;
end;
$$;

revoke all on table public.keyflow_page_views from anon, authenticated;
revoke all on function public.keyflow_track_page_view(text, uuid, uuid, uuid) from public;
revoke all on function public.keyflow_admin_analytics_overview(uuid, text) from public;
grant execute on function public.keyflow_track_page_view(text, uuid, uuid, uuid) to anon, authenticated;
grant execute on function public.keyflow_admin_analytics_overview(uuid, text) to anon;
