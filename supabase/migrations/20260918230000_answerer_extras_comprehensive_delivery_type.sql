-- 答主看板「曾提交作品」的稿件类型：综合活动申领页交的稿按「是否命中活动题库」归类（2026-09-18）
--
-- 背景：综合活动的稿子可能落在两张表里——综合活动投稿表（看板/综合活动页投稿框），
--   以及交付表（申领页「提交作品」，已于 9/18 关掉该入口，但历史仍有 21 条）。
--   产品口径（三分类）：命中活动题库 → 综合活动；未命中 → 日常投稿；测评活动交付 → 活动稿件。
--   所以这里把「交付表 + 活动是综合活动」的行按命中结果给出 type，而不是一律 'activity'。
--
-- 影响：keyflow_answerer_dashboard_extras() 的 submissions[].type
--   （前端 submissionTypeLabel/submissionTypeClass 渲染「日常稿件 / 综合活动 / 活动稿件」）
--
-- 回滚：把 ① 分支的 'type' 恢复成常量 'activity' 即可。

CREATE OR REPLACE FUNCTION public.keyflow_answerer_dashboard_extras(p_answerer_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
          -- ① 交付表（测评活动交稿 = 活动稿件；综合活动申领页交稿按命中归到「综合活动 / 日常」）
          select jsonb_build_object(
            'type', case
              when coalesce(a.activity_type, 'game') = 'comprehensive' then
                case when exists (
                       select 1 from public.keyflow_activity_questions q
                        where q.activity_id = a.id
                          and q.question_id is not null
                          and q.question_id = public.keyflow_extract_zhihu_question_id(d.article_url)
                     ) then 'comprehensive' else 'daily' end
              else 'activity'
            end,
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
$function$;
