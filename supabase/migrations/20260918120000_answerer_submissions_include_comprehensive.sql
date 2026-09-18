-- 答主看板「曾提交作品」补上综合活动投稿（2026-09-18）
--
-- 问题：keyflow_answerer_dashboard_extras 的 submissions 只并了「测评交付 + 日常投稿」，
--       综合活动投稿（keyflow_comprehensive_submissions）一条都不返回，
--       所以答主命中活动题目后投的稿，在自己看板里看不到 → 反馈「曾提交稿件查不到」。
--
-- 产品口径（2026-09-18 确认）：答主所有已提交作品都要在答主看板「曾提交作品」展示，
--       其中综合活动投稿的「稿件类型」列显示「综合活动」（前端按 type='comprehensive' 渲染）。
--
-- 改动：只改 keyflow_answerer_dashboard_extras 的 submissions 部分——
--       新增第三个来源（keyflow_comprehensive_submissions，带活动名），
--       并把最近条数上限从 100 放宽到 300（避免稿件多的答主被截断）。
--       「是否处理」列前端是按链接查两张投稿表的 processed，本来就已经覆盖活动投稿，无需改函数。

begin;

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
        'delivery_deadline', a.delivery_deadline,
        'min_level', coalesce(a.min_level, 0)
      ) order by a.created_at desc)
      from public.keyflow_activities a
      where a.is_online = true
        and (
          a.status = 'recruiting'
          or (
            a.status in ('key_distribution', 'delivery', 'completed')
            and a.exempted_answerer_ids ? p_answerer_id::text
          )
        )
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
          'application_status', app.status,
          'has_delivery', coalesce(has_del.has_del, false)
        ) as entry, a.created_at as created_at
        from public.keyflow_activities a
        left join public.keyflow_applications app
          on app.activity_id = a.id and app.answerer_id = p_answerer_id
        left join lateral (
          select exists(
            select 1 from public.keyflow_deliveries d
            join public.keyflow_applications app2 on app2.id = d.application_id
            where app2.activity_id = a.id and app2.answerer_id = p_answerer_id
          ) as has_del
        ) has_del on true
        where (a.is_online = true or app.id is not null)
          and a.status not in ('draft', 'recruiting')
          and (a.status != 'completed' or not (a.exempted_answerer_ids ? p_answerer_id::text) or has_del.has_del)
          and (
            a.status = 'completed'
            or app.id is null
            or app.status = 'rejected'
            or has_del.has_del
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
          'application_status', app.status,
          'has_delivery', false
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
          -- ① 测评交付（活动交稿）
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

          -- ② 日常投稿
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

          union all

          -- ③ 综合活动投稿（2026-09-18 新增）：命中活动题库后入库的稿件
          select jsonb_build_object(
            'type', 'comprehensive',
            'activity_id', cs.activity_id,
            'activity_title', a.title,
            'game_name', a.game_name,
            'article_title', cs.article_title,
            'article_url', cs.article_url,
            'submitted_at', cs.submitted_at
          ) as entry, cs.submitted_at as submitted_at
          from public.keyflow_comprehensive_submissions cs
          left join public.keyflow_activities a on a.id = cs.activity_id
          where cs.answerer_id = p_answerer_id
        ) combined
        order by submitted_at desc
        limit 300
      ) recent_submissions
    ), '[]'::jsonb)
  );
end;
$$;

grant execute on function public.keyflow_answerer_dashboard_extras(uuid) to anon, authenticated;

commit;

-- 自检：按 type 统计某位答主的作品条数（挑一位既有日常投稿又有活动投稿的答主）
select jsonb_build_object(
  'yazou_total', jsonb_array_length(public.keyflow_answerer_dashboard_extras('588ecb80-cacf-41cb-9e02-c7e768f3902c')->'submissions'),
  'yazou_by_type', (
    select jsonb_object_agg(t.type, t.n)
    from (
      select item->>'type' as type, count(*) as n
      from jsonb_array_elements(public.keyflow_answerer_dashboard_extras('588ecb80-cacf-41cb-9e02-c7e768f3902c')->'submissions') item
      group by 1
    ) t
  ),
  'bailing_by_type', (
    select jsonb_object_agg(t.type, t.n)
    from (
      select item->>'type' as type, count(*) as n
      from jsonb_array_elements(public.keyflow_answerer_dashboard_extras('8d283a3d-650e-4d74-ba65-b420b7429f36')->'submissions') item
      group by 1
    ) t
  )
) as applied;
