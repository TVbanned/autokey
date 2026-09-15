-- 综合活动指定问题奖励：以知乎 Question ID 而非完整回答 URL 判定。
-- 仅匹配 /question/<id>/answer(s)/<answer-id> 或 API questions URL；无法反推问题的短回答链接不会领奖。
-- 同一答主针对同一指定问题仅奖励一次。

create or replace function public.keyflow_extract_zhihu_question_id(p_url text)
returns text
language sql
immutable
as $$
  select coalesce(
    (regexp_match(coalesce(p_url, ''), 'https?://(?:www\.)?zhihu\.com/question/([0-9]+)(?:/|$)', 'i'))[1],
    (regexp_match(coalesce(p_url, ''), 'https?://(?:www\.)?zhihu\.com/api/v4/questions/([0-9]+)(?:/|$)', 'i'))[1]
  );
$$;

alter table public.keyflow_activity_questions
  add column if not exists question_id text,
  add column if not exists reward_coins integer not null default 0 check (reward_coins >= 0);

update public.keyflow_activity_questions
set question_id = public.keyflow_extract_zhihu_question_id(question_url)
where question_id is distinct from public.keyflow_extract_zhihu_question_id(question_url);

create or replace function public.keyflow_set_activity_question_id()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.question_id := public.keyflow_extract_zhihu_question_id(new.question_url);
  return new;
end;
$$;

drop trigger if exists trg_keyflow_set_activity_question_id on public.keyflow_activity_questions;
create trigger trg_keyflow_set_activity_question_id
before insert or update of question_url on public.keyflow_activity_questions
for each row execute function public.keyflow_set_activity_question_id();

create unique index if not exists keyflow_activity_questions_question_id_unique
  on public.keyflow_activity_questions (activity_id, question_id)
  where question_id is not null;

create table if not exists public.keyflow_activity_question_rewards (
  id uuid primary key default gen_random_uuid(),
  activity_id uuid not null references public.keyflow_activities(id) on delete cascade,
  question_id text not null,
  activity_question_id uuid not null references public.keyflow_activity_questions(id) on delete cascade,
  daily_submission_id uuid not null references public.keyflow_daily_submissions(id) on delete cascade,
  answerer_id uuid not null references public.keyflow_answerers(id) on delete cascade,
  coins integer not null check (coins > 0),
  created_at timestamptz not null default now(),
  unique (activity_id, question_id, answerer_id),
  unique (daily_submission_id, activity_question_id)
);

alter table public.keyflow_activity_question_rewards enable row level security;
drop policy if exists "keyflow public activity question rewards access" on public.keyflow_activity_question_rewards;
create policy "keyflow public activity question rewards access" on public.keyflow_activity_question_rewards
  for all to anon, authenticated using (true) with check (true);

create index if not exists keyflow_activity_question_rewards_answerer_idx
  on public.keyflow_activity_question_rewards (answerer_id, created_at desc);

create or replace function public.keyflow_reward_comprehensive_question_submission()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_question_id text;
  v_reward record;
  v_reward_id uuid;
begin
  if new.answerer_id is null then
    return new;
  end if;

  v_question_id := public.keyflow_extract_zhihu_question_id(new.article_url);
  if v_question_id is null then
    return new;
  end if;

  for v_reward in
    select q.id, q.activity_id, q.question_text, q.reward_coins, a.title as activity_title
    from public.keyflow_activity_questions q
    join public.keyflow_activities a on a.id = q.activity_id
    where q.question_id = v_question_id
      and q.reward_coins > 0
      and a.activity_type = 'comprehensive'
      and a.status <> 'completed'
      and (a.activity_start_time is null or a.activity_start_time <= now())
      and (a.activity_end_time is null or a.activity_end_time >= now())
  loop
    insert into public.keyflow_activity_question_rewards (
      activity_id, question_id, activity_question_id, daily_submission_id, answerer_id, coins
    ) values (
      v_reward.activity_id, v_question_id, v_reward.id, new.id, new.answerer_id, v_reward.reward_coins
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

  return new;
end;
$$;

drop trigger if exists trg_keyflow_reward_comprehensive_question_submission on public.keyflow_daily_submissions;
create trigger trg_keyflow_reward_comprehensive_question_submission
after insert on public.keyflow_daily_submissions
for each row execute function public.keyflow_reward_comprehensive_question_submission();
