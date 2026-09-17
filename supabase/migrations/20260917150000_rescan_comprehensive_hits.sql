-- 综合活动题库会持续新增问题（腾讯文档「新增问题」后同步）。题库变大时，
-- 之前投过稿、但当时题目还不在库里的答主，命中次数会自动跟着涨（keyflow_answerer_activity_hits 是三表实时匹配），
-- 但「单题额外金币」和「活动完成奖励」只在投稿写入那一刻由触发器结算，历史投稿不会被补上。
-- 所以每次同步题库后，回扫一遍三张投稿表，把命中对应的奖励补齐（函数可重复调用，靠唯一键去重）。
--
-- 调用方式：后台「综合活动概览 → 从腾讯文档同步」按钮，同步完问题后自动调用本函数。

begin;

create or replace function public.keyflow_rescan_comprehensive_hits(p_activity_id uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_start_reward_ids uuid[];
  v_start_completion_ids uuid[];
  v_rec record;
  v_daily integer := 0;
  v_comprehensive integer := 0;
  v_delivery integer := 0;
  v_new_rewards jsonb := '[]'::jsonb;
  v_new_completions jsonb := '[]'::jsonb;
  v_reward_coins integer := 0;
  v_completion_coins integer := 0;
begin
  select coalesce(array_agg(id), '{}'::uuid[]) into v_start_reward_ids
    from public.keyflow_activity_question_rewards;
  select coalesce(array_agg(id), '{}'::uuid[]) into v_start_completion_ids
    from public.keyflow_activity_completion_rewards;

  -- ① 日常投稿（今日投稿）
  for v_rec in
    select ds.id as row_id, ds.answerer_id, ds.article_url
    from public.keyflow_daily_submissions ds
    join public.keyflow_activity_questions q
      on q.question_id is not null
     and q.question_id = public.keyflow_extract_zhihu_question_id(ds.article_url)
    join public.keyflow_activities a on a.id = q.activity_id
    where ds.answerer_id is not null
      and a.activity_type = 'comprehensive'
      and coalesce(a.status, '') <> 'completed'
      and (p_activity_id is null or q.activity_id = p_activity_id)
  loop
    perform public.keyflow_settle_comprehensive_hit(v_rec.answerer_id, v_rec.article_url, v_rec.row_id, null);
    v_daily := v_daily + 1;
  end loop;

  -- ② 综合活动投稿（活动页投稿框）
  for v_rec in
    select cs.id as row_id, cs.answerer_id, cs.article_url
    from public.keyflow_comprehensive_submissions cs
    join public.keyflow_activity_questions q
      on q.question_id is not null
     and q.question_id = public.keyflow_extract_zhihu_question_id(cs.article_url)
    join public.keyflow_activities a on a.id = q.activity_id
    where cs.answerer_id is not null
      and a.activity_type = 'comprehensive'
      and coalesce(a.status, '') <> 'completed'
      and (p_activity_id is null or q.activity_id = p_activity_id)
  loop
    perform public.keyflow_settle_comprehensive_hit(v_rec.answerer_id, v_rec.article_url, null, v_rec.row_id);
    v_comprehensive := v_comprehensive + 1;
  end loop;

  -- ③ 测评投稿（申领页交付）
  for v_rec in
    select ap.answerer_id, d.article_url
    from public.keyflow_deliveries d
    join public.keyflow_applications ap on ap.id = d.application_id
    join public.keyflow_activity_questions q
      on q.question_id is not null
     and q.question_id = public.keyflow_extract_zhihu_question_id(d.article_url)
    join public.keyflow_activities a on a.id = q.activity_id
    where ap.answerer_id is not null
      and a.activity_type = 'comprehensive'
      and coalesce(a.status, '') <> 'completed'
      and (p_activity_id is null or q.activity_id = p_activity_id)
  loop
    perform public.keyflow_settle_comprehensive_hit(v_rec.answerer_id, v_rec.article_url, null, null);
    v_delivery := v_delivery + 1;
  end loop;

  -- 汇总这次回扫新产生的奖励（用调用前后的行 id 差集，避免依赖事务时间戳）
  select coalesce(jsonb_agg(jsonb_build_object(
           'answerer_id', r.answerer_id,
           'answerer', (select zhihu_name from public.keyflow_answerers an where an.id = r.answerer_id),
           'coins', r.coins,
           'question', (select q.question_text from public.keyflow_activity_questions q where q.id = r.activity_question_id)
         )), '[]'::jsonb),
         coalesce(sum(r.coins), 0)
    into v_new_rewards, v_reward_coins
    from public.keyflow_activity_question_rewards r
   where not (r.id = any (v_start_reward_ids));

  select coalesce(jsonb_agg(jsonb_build_object(
           'answerer_id', c.answerer_id,
           'answerer', (select zhihu_name from public.keyflow_answerers an where an.id = c.answerer_id),
           'hits', c.submission_count,
           'coins', c.coins,
           'exp', c.exp_amount
         )), '[]'::jsonb),
         coalesce(sum(c.coins), 0)
    into v_new_completions, v_completion_coins
    from public.keyflow_activity_completion_rewards c
   where not (c.id = any (v_start_completion_ids));

  return jsonb_build_object(
    'activity_id', p_activity_id,
    'scanned', jsonb_build_object(
      'daily', v_daily,
      'comprehensive', v_comprehensive,
      'delivery', v_delivery,
      'total', v_daily + v_comprehensive + v_delivery
    ),
    'new_question_rewards', v_new_rewards,
    'new_completion_rewards', v_new_completions,
    'coins_issued', v_reward_coins + v_completion_coins
  );
end;
$$;

grant execute on function public.keyflow_rescan_comprehensive_hits(uuid) to anon, authenticated;

commit;
