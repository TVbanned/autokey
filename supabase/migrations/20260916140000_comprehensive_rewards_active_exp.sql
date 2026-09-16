-- 综合活动激励闭环（2026-09-16）：
--   1) 活动投稿 = 一次日常创作：计入活跃日（与日常投稿同口径）
--   2) 活动投稿计入经验：默认 40/篇（与日常投稿同额，列默认值可调）
--   3) 命中活动指定问题的投稿按题发额外金币（原触发器只挂 keyflow_daily_submissions，改成活动投稿后失效）
--   4) 达到「本次最少提交作品数」后一次性发「完成可得金币 / 完成可得经验」，发过不再重复
--   5) 活动新增 completion_reward_exp（后台创建/编辑可配）

begin;

-- ---------- 1. 活动：完成可得经验 ----------
alter table public.keyflow_activities
  add column if not exists completion_reward_exp integer not null default 0;

alter table public.keyflow_activities
  drop constraint if exists keyflow_activities_completion_reward_exp_check;
alter table public.keyflow_activities
  add constraint keyflow_activities_completion_reward_exp_check check (completion_reward_exp >= 0);

-- ---------- 2. 活动投稿：经验值 ----------
alter table public.keyflow_comprehensive_submissions
  add column if not exists xp_value integer not null default 40;

alter table public.keyflow_comprehensive_submissions
  drop constraint if exists keyflow_comprehensive_submissions_xp_value_check;
alter table public.keyflow_comprehensive_submissions
  add constraint keyflow_comprehensive_submissions_xp_value_check check (xp_value >= 0);

-- ---------- 3. 问题奖励表：兼容「活动投稿」来源 ----------
alter table public.keyflow_activity_question_rewards
  add column if not exists comprehensive_submission_id uuid
    references public.keyflow_comprehensive_submissions(id) on delete cascade;

-- 原表只记日常投稿，daily_submission_id 为 not null；活动投稿没有日常投稿行，放开非空
alter table public.keyflow_activity_question_rewards
  alter column daily_submission_id drop not null;

drop index if exists public.keyflow_aqr_comprehensive_unique;
create unique index keyflow_aqr_comprehensive_unique
  on public.keyflow_activity_question_rewards (comprehensive_submission_id, activity_question_id)
  where comprehensive_submission_id is not null;

-- ---------- 4. 完成奖励发放台账（同一活动 + 同一答主只发一次） ----------
create table if not exists public.keyflow_activity_completion_rewards (
  id uuid primary key default gen_random_uuid(),
  activity_id uuid not null references public.keyflow_activities(id) on delete cascade,
  answerer_id uuid not null references public.keyflow_answerers(id) on delete cascade,
  submission_count integer not null default 0,
  coins integer not null default 0 check (coins >= 0),
  exp_amount integer not null default 0 check (exp_amount >= 0),
  created_at timestamptz not null default now(),
  unique (activity_id, answerer_id)
);

create index if not exists keyflow_activity_completion_rewards_answerer_idx
  on public.keyflow_activity_completion_rewards (answerer_id, created_at desc);

alter table public.keyflow_activity_completion_rewards enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'keyflow_activity_completion_rewards'
      and policyname = 'keyflow public activity completion rewards access'
  ) then
    create policy "keyflow public activity completion rewards access"
      on public.keyflow_activity_completion_rewards
      for all to anon, authenticated using (true) with check (true);
  end if;
end $$;

grant all on public.keyflow_activity_completion_rewards to anon, authenticated;

-- ---------- 5. 经验口径：日常投稿 + 活动投稿 + 活动完成奖励 ----------
create or replace function public.keyflow_answerer_exp(p_answerer_id uuid)
returns bigint
language sql stable
set search_path = public
as $$
  select
    (select count(distinct activity_id) * 50 from keyflow_applications
      where answerer_id = p_answerer_id and status = 'selected')
    + (select count(*) * 300 from keyflow_applications a
        join keyflow_deliveries d on d.application_id = a.id
       where a.answerer_id = p_answerer_id)
    + (select coalesce(sum(xp_value), 0) from keyflow_daily_submissions
       where answerer_id = p_answerer_id)
    + (select coalesce(sum(xp_value), 0) from keyflow_comprehensive_submissions
       where answerer_id = p_answerer_id)
    + (select coalesce(sum(exp_amount), 0) from keyflow_activity_completion_rewards
       where answerer_id = p_answerer_id);
$$;

-- ---------- 6. 活动投稿结算：活跃 + 指定问题奖励 + 完成奖励 ----------
create or replace function public.keyflow_settle_comprehensive_submission()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_question_id text;
  v_reward record;
  v_reward_id uuid;
  v_act record;
  v_done integer;
begin
  if new.answerer_id is null then
    return new;
  end if;

  -- 活动投稿等同一次日常创作：先结算活跃日
  perform public.keyflow_mark_answerer_active(new.answerer_id);

  -- 命中活动指定问题 → 额外金币（同一答主同一题只发一次）
  v_question_id := public.keyflow_extract_zhihu_question_id(new.article_url);
  if v_question_id is not null then
    for v_reward in
      select q.id, q.reward_coins, q.question_text, a.title as activity_title
      from public.keyflow_activity_questions q
      join public.keyflow_activities a on a.id = q.activity_id
      where q.activity_id = new.activity_id
        and q.question_id = v_question_id
        and q.reward_coins > 0
        and coalesce(a.status, '') <> 'completed'
    loop
      v_reward_id := null;
      insert into public.keyflow_activity_question_rewards (
        activity_id, question_id, activity_question_id, comprehensive_submission_id, answerer_id, coins
      ) values (
        new.activity_id, v_question_id, v_reward.id, new.id, new.answerer_id, v_reward.reward_coins
      ) on conflict (activity_id, question_id, answerer_id) do nothing
      returning id into v_reward_id;

      if v_reward_id is not null then
        insert into public.keyflow_coins_ledger (answerer_id, amount, source, ref_id, note)
        values (
          new.answerer_id,
          v_reward.reward_coins,
          'activity_reward',
          v_reward_id,
          '综合活动指定问题奖励：' || coalesce(v_reward.activity_title, '') || ' · ' || coalesce(v_reward.question_text, '')
        );
      end if;
    end loop;
  end if;

  -- 达到最少投稿数 → 一次性发完成奖励（金币 + 经验）
  select id, title, min_submission_count, completion_reward_coins, completion_reward_exp
    into v_act
  from public.keyflow_activities where id = new.activity_id;

  if v_act.id is not null
     and coalesce(v_act.min_submission_count, 0) > 0
     and (coalesce(v_act.completion_reward_coins, 0) > 0 or coalesce(v_act.completion_reward_exp, 0) > 0) then
    select count(*) into v_done
    from public.keyflow_comprehensive_submissions
    where answerer_id = new.answerer_id
      and activity_id = new.activity_id;

    if v_done >= v_act.min_submission_count then
      v_reward_id := null;
      insert into public.keyflow_activity_completion_rewards (
        activity_id, answerer_id, submission_count, coins, exp_amount
      ) values (
        new.activity_id, new.answerer_id, v_done,
        coalesce(v_act.completion_reward_coins, 0), coalesce(v_act.completion_reward_exp, 0)
      ) on conflict (activity_id, answerer_id) do nothing
      returning id into v_reward_id;

      if v_reward_id is not null and coalesce(v_act.completion_reward_coins, 0) > 0 then
        insert into public.keyflow_coins_ledger (answerer_id, amount, source, ref_id, note)
        values (
          new.answerer_id,
          v_act.completion_reward_coins,
          'activity_reward',
          v_reward_id,
          '综合活动完成奖励：' || coalesce(v_act.title, '') || '（已投 ' || v_done || ' 篇）'
        );
      end if;
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_settle_comprehensive_submission on public.keyflow_comprehensive_submissions;
create trigger trg_settle_comprehensive_submission
after insert on public.keyflow_comprehensive_submissions
for each row execute function public.keyflow_settle_comprehensive_submission();

-- ---------- 7. 报名也算活跃 ----------
-- FAQ 口径是「日常投稿 / 提交测评交付 / 报名 / 领 Key 任意一项就算活跃」，但前端报名走的是直接
-- upsert keyflow_applications（没走 keyflow_apply_with_gate），所以报名一直没结算活跃。这里补触发器。
create or replace function public.keyflow_mark_active_on_application()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.answerer_id is not null then
    perform public.keyflow_mark_answerer_active(new.answerer_id);
  end if;
  return new;
end;
$$;

drop trigger if exists trg_mark_active_on_application on public.keyflow_applications;
create trigger trg_mark_active_on_application
after insert on public.keyflow_applications
for each row execute function public.keyflow_mark_active_on_application();

commit;
