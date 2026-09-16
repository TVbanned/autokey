-- 综合活动投稿：命中活动问题 URL 的投稿独立成表，不再进入日常投稿表；
-- 每日额度 = 等级固定投稿篇数之外的「+3 篇」，由触发器兜底校验。

create table if not exists public.keyflow_comprehensive_submissions (
  id uuid primary key default gen_random_uuid(),
  answerer_id uuid not null references public.keyflow_answerers(id) on delete cascade,
  activity_id uuid not null references public.keyflow_activities(id) on delete cascade,
  question_url text not null default '',
  article_url text not null check (length(trim(article_url)) > 0),
  article_title text not null default '',
  reviewed boolean not null default false,
  processed boolean not null default false,
  submitted_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create index if not exists keyflow_comprehensive_submissions_answerer_idx
  on public.keyflow_comprehensive_submissions(answerer_id, created_at desc);
create index if not exists keyflow_comprehensive_submissions_activity_idx
  on public.keyflow_comprehensive_submissions(activity_id, created_at desc);

alter table public.keyflow_comprehensive_submissions enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'keyflow_comprehensive_submissions'
      and policyname = 'keyflow public comprehensive submissions access'
  ) then
    create policy "keyflow public comprehensive submissions access"
      on public.keyflow_comprehensive_submissions
      for all to anon, authenticated using (true) with check (true);
  end if;
end $$;

grant all on public.keyflow_comprehensive_submissions to anon, authenticated;

-- 活动每日可额外投稿篇数（在等级固定投稿篇数之外）
create or replace function public.keyflow_comprehensive_daily_limit()
returns integer
language sql
immutable
as $$ select 3 $$;

create or replace function public.keyflow_enforce_comprehensive_daily_limit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_limit int;
  v_today int;
begin
  v_limit := public.keyflow_comprehensive_daily_limit();

  select count(*) into v_today
  from public.keyflow_comprehensive_submissions
  where answerer_id = new.answerer_id
    and (created_at at time zone 'Asia/Shanghai')::date = (now() at time zone 'Asia/Shanghai')::date;

  if v_today >= v_limit then
    raise exception '今日活动投稿已达上限（每天 % 篇）', v_limit;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_comprehensive_daily_limit on public.keyflow_comprehensive_submissions;
create trigger trg_comprehensive_daily_limit
  before insert on public.keyflow_comprehensive_submissions
  for each row execute function public.keyflow_enforce_comprehensive_daily_limit();
