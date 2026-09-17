-- 修复「同步题库 → 回扫重复发币」：
-- fetch-activity-questions 的做法是 delete 该活动全部题目、再重新插入，
-- 而 keyflow_activity_question_rewards 通过 activity_question_id / daily_submission_id /
-- comprehensive_submission_id 三个外键 ON DELETE CASCADE 挂在题目和投稿上：
-- 题目被删 → 奖励行连带被删 → (activity_id, question_id, answerer_id) 这个去重键消失 →
-- 下一次回扫（keyflow_rescan_comprehensive_hits）会把这笔单题金币再发一遍。
--
-- 结论：奖励是「已经发出去的钱」，不能跟着题目/投稿的删除而消失。
-- 这里把三个外键改成 ON DELETE SET NULL（保留奖励行与去重键）。
-- 去重键 (activity_id, question_id, answerer_id) 与 activity_id/answerer_id 的外键保持不变。

begin;

alter table public.keyflow_activity_question_rewards
  drop constraint if exists keyflow_activity_question_rewards_activity_question_id_fkey,
  drop constraint if exists keyflow_activity_question_rewards_daily_submission_id_fkey,
  drop constraint if exists keyflow_activity_question_rewa_comprehensive_submission_id_fkey;

alter table public.keyflow_activity_question_rewards
  add constraint keyflow_activity_question_rewards_activity_question_id_fkey
    foreign key (activity_question_id) references public.keyflow_activity_questions(id) on delete set null,
  add constraint keyflow_activity_question_rewards_daily_submission_id_fkey
    foreign key (daily_submission_id) references public.keyflow_daily_submissions(id) on delete set null,
  add constraint keyflow_activity_question_rewa_comprehensive_submission_id_fkey
    foreign key (comprehensive_submission_id) references public.keyflow_comprehensive_submissions(id) on delete set null;

-- 回扫报告里的题目文本：题目行被同步重建后 activity_question_id 可能为 null，回退按 question_id 找
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

  select coalesce(jsonb_agg(jsonb_build_object(
           'answerer_id', r.answerer_id,
           'answerer', (select zhihu_name from public.keyflow_answerers an where an.id = r.answerer_id),
           'coins', r.coins,
           'question', coalesce(
             (select q.question_text from public.keyflow_activity_questions q where q.id = r.activity_question_id),
             (select q.question_text from public.keyflow_activity_questions q
               where q.activity_id = r.activity_id and q.question_id = r.question_id limit 1),
             r.question_id
           )
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
