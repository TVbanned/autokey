-- 综合活动「命中即算」统一口径（2026-09-17）：
--   1) 不论在哪个入口投稿（申领页交付 / 今日投稿日常投稿 / 综合活动投稿框），
--      只要 URL 命中该综合活动题库里的问题 → 算一次活动参与（x），并计入完成奖励进度。
--   2) 命中「有额外金币」的题 → 立刻发该题金币（同一答主同一题只发一次，跨入口去重）。
--   3) 达到 min_submission_count → 发完成奖励（金币 + 经验，只发一次）。
--   4) 补发：把历史上已命中但没算/没发的投稿补齐。
-- 说明：原来只在「综合活动投稿表」上结算，日常投稿/评测投稿命中时会被漏掉（前端路由/活动在线状态都会影响），
--       现在改为三张表统一处理，服务端口径 = 命中即算。

begin;

-- ---------- 1. 统一命中计数（三张表取并集，按题目命中计数） ----------
create or replace function public.keyflow_answerer_activity_hits(p_answerer_id uuid, p_activity_id uuid)
returns integer
language sql
stable
security definer
set search_path = public
as $$
  select count(*)::int
  from (
    select ds.article_url from public.keyflow_daily_submissions ds where ds.answerer_id = p_answerer_id
    union all
    select cs.article_url from public.keyflow_comprehensive_submissions cs where cs.answerer_id = p_answerer_id
    union all
    select d.article_url from public.keyflow_deliveries d
      join public.keyflow_applications ap on ap.id = d.application_id
     where ap.answerer_id = p_answerer_id
  ) s
  join public.keyflow_activity_questions q
    on q.activity_id = p_activity_id
   and q.question_id is not null
   and q.question_id = public.keyflow_extract_zhihu_question_id(s.article_url);
$$;

grant execute on function public.keyflow_answerer_activity_hits(uuid, uuid) to anon, authenticated;

-- ---------- 2. 统一结算：单题额外金币 + 完成奖励 ----------
create or replace function public.keyflow_settle_comprehensive_hit(
  p_answerer_id uuid,
  p_article_url text,
  p_daily_submission_id uuid default null,
  p_comprehensive_submission_id uuid default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_question_id text;
  v_rec record;
  v_reward_id uuid;
  v_hits integer;
begin
  if p_answerer_id is null then return; end if;

  v_question_id := public.keyflow_extract_zhihu_question_id(p_article_url);
  if v_question_id is null then return; end if;

  for v_rec in
    select q.id as question_pk, q.activity_id, q.question_text, q.reward_coins,
           a.title as activity_title, a.status as activity_status,
           coalesce(a.min_submission_count, 0) as min_submission_count,
           coalesce(a.completion_reward_coins, 0) as completion_reward_coins,
           coalesce(a.completion_reward_exp, 0) as completion_reward_exp
    from public.keyflow_activity_questions q
    join public.keyflow_activities a on a.id = q.activity_id
    where q.question_id = v_question_id
      and a.activity_type = 'comprehensive'
      and coalesce(a.status, '') <> 'completed'
  loop
    -- ① 命中「有额外金币」的题：同一答主同一题只发一次（跨入口靠唯一键去重）
    if v_rec.reward_coins > 0 then
      v_reward_id := null;
      insert into public.keyflow_activity_question_rewards (
        activity_id, question_id, activity_question_id, daily_submission_id, comprehensive_submission_id, answerer_id, coins
      ) values (
        v_rec.activity_id, v_question_id, v_rec.question_pk, p_daily_submission_id, p_comprehensive_submission_id,
        p_answerer_id, v_rec.reward_coins
      ) on conflict (activity_id, question_id, answerer_id) do nothing
      returning id into v_reward_id;

      if v_reward_id is not null then
        insert into public.keyflow_coins_ledger (answerer_id, amount, source, ref_id, note)
        values (
          p_answerer_id, v_rec.reward_coins, 'activity_reward', v_reward_id,
          '综合活动指定问题奖励：' || coalesce(v_rec.activity_title, '') || ' · ' || coalesce(v_rec.question_text, '')
        );
      end if;
    end if;

    -- ② 完成奖励：进度用统一口径（三张表命中数）
    if v_rec.min_submission_count > 0
       and (v_rec.completion_reward_coins > 0 or v_rec.completion_reward_exp > 0) then
      v_hits := public.keyflow_answerer_activity_hits(p_answerer_id, v_rec.activity_id);
      if v_hits >= v_rec.min_submission_count then
        v_reward_id := null;
        insert into public.keyflow_activity_completion_rewards (activity_id, answerer_id, submission_count, coins, exp_amount)
        values (v_rec.activity_id, p_answerer_id, v_hits, v_rec.completion_reward_coins, v_rec.completion_reward_exp)
        on conflict (activity_id, answerer_id) do nothing
        returning id into v_reward_id;

        if v_reward_id is not null and v_rec.completion_reward_coins > 0 then
          insert into public.keyflow_coins_ledger (answerer_id, amount, source, ref_id, note)
          values (
            p_answerer_id, v_rec.completion_reward_coins, 'activity_reward', v_reward_id,
            '综合活动完成奖励：' || coalesce(v_rec.activity_title, '') || '（已投 ' || v_hits || ' 篇）'
          );
        end if;
      end if;
    end if;
  end loop;
end;
$$;

-- ---------- 3. 三个入口的触发器都走同一套结算 ----------
-- 3.1 日常投稿（今日投稿）
create or replace function public.keyflow_reward_comprehensive_question_submission()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.keyflow_settle_comprehensive_hit(new.answerer_id, new.article_url, new.id, null);
  return new;
end;
$$;

-- 3.2 综合活动投稿（活动页投稿框）
create or replace function public.keyflow_settle_comprehensive_submission()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.answerer_id is null then return new; end if;
  perform public.keyflow_mark_answerer_active(new.answerer_id);
  perform public.keyflow_settle_comprehensive_hit(new.answerer_id, new.article_url, null, new.id);
  return new;
end;
$$;

-- 3.3 测评投稿（申领页交付）
create or replace function public.keyflow_settle_comprehensive_delivery()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_answerer uuid;
begin
  select ap.answerer_id into v_answerer
  from public.keyflow_applications ap where ap.id = new.application_id;
  if v_answerer is not null then
    perform public.keyflow_settle_comprehensive_hit(v_answerer, new.article_url, null, null);
  end if;
  return new;
end;
$$;

drop trigger if exists trg_settle_comprehensive_delivery on public.keyflow_deliveries;
create trigger trg_settle_comprehensive_delivery
after insert on public.keyflow_deliveries
for each row execute function public.keyflow_settle_comprehensive_delivery();

-- ---------- 4. 补发历史命中（日常投稿 + 评测投稿） ----------
do $$
declare
  v_daily integer := 0;
  v_delivery integer := 0;
begin
  select count(*) into v_daily from (
    select public.keyflow_settle_comprehensive_hit(ds.answerer_id, ds.article_url, ds.id, null)
    from public.keyflow_daily_submissions ds
    where ds.answerer_id is not null
      and public.keyflow_extract_zhihu_question_id(ds.article_url) in (
        select q.question_id from public.keyflow_activity_questions q where q.question_id is not null)
  ) t;

  select count(*) into v_delivery from (
    select public.keyflow_settle_comprehensive_hit(ap.answerer_id, d.article_url, null, null)
    from public.keyflow_deliveries d
    join public.keyflow_applications ap on ap.id = d.application_id
    where ap.answerer_id is not null
      and public.keyflow_extract_zhihu_question_id(d.article_url) in (
        select q.question_id from public.keyflow_activity_questions q where q.question_id is not null)
  ) t;

  raise notice '补发扫描：日常投稿 % 条、评测投稿 % 条', v_daily, v_delivery;
end $$;

commit;
