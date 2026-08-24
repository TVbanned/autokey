-- 徽章系统：每款游戏对应一个成就徽章，答主提交交付物即自动获得（按游戏去重）

create table if not exists public.keyflow_badges (
  id uuid primary key default gen_random_uuid(),
  game_name text not null unique,
  name text not null,
  description text not null default '',
  created_at timestamptz not null default now()
);

create table if not exists public.keyflow_user_badges (
  id uuid primary key default gen_random_uuid(),
  answerer_id uuid not null references public.keyflow_answerers(id) on delete cascade,
  badge_id uuid not null references public.keyflow_badges(id) on delete cascade,
  awarded_at timestamptz not null default now(),
  unique (answerer_id, badge_id)
);

create index if not exists keyflow_user_badges_answerer_idx on public.keyflow_user_badges(answerer_id);

-- 交付提交时自动发放徽章（同一游戏只发一次）
create or replace function public.keyflow_award_badge_on_delivery()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_game_name text;
  v_answerer_id uuid;
  v_badge_id uuid;
begin
  select a.game_name, app.answerer_id
    into v_game_name, v_answerer_id
  from public.keyflow_applications app
  join public.keyflow_activities a on a.id = app.activity_id
  where app.id = new.application_id;

  if v_game_name is null or v_game_name = '' or v_answerer_id is null then
    return new;
  end if;

  insert into public.keyflow_badges (game_name, name)
  values (v_game_name, v_game_name || ' · 成就徽章')
  on conflict (game_name) do nothing;

  select id into v_badge_id from public.keyflow_badges where game_name = v_game_name;

  insert into public.keyflow_user_badges (answerer_id, badge_id)
  values (v_answerer_id, v_badge_id)
  on conflict (answerer_id, badge_id) do nothing;

  return new;
end;
$$;

drop trigger if exists trg_keyflow_award_badge_on_delivery on public.keyflow_deliveries;
create trigger trg_keyflow_award_badge_on_delivery
  after insert on public.keyflow_deliveries
  for each row execute function public.keyflow_award_badge_on_delivery();

-- 查询答主徽章（含已获得 / 未解锁）
create or replace function public.keyflow_answerer_badges(p_answerer_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'game_name', b.game_name,
      'name', b.name,
      'earned', (ub.id is not null),
      'awarded_at', ub.awarded_at
    ) order by (ub.id is not null) desc, ub.awarded_at desc nulls last, b.created_at desc)
    from public.keyflow_badges b
    left join public.keyflow_user_badges ub
      on ub.badge_id = b.id and ub.answerer_id = p_answerer_id
  ), '[]'::jsonb);
end;
$$;

grant execute on function public.keyflow_answerer_badges(uuid) to anon, authenticated;

-- 为已有游戏补充徽章
insert into public.keyflow_badges (game_name, name)
select distinct a.game_name, a.game_name || ' · 成就徽章'
from public.keyflow_activities a
where a.game_name is not null and a.game_name <> ''
on conflict (game_name) do nothing;

-- 为历史已提交的交付物补发徽章
insert into public.keyflow_user_badges (answerer_id, badge_id)
select distinct app.answerer_id, b.id
from public.keyflow_deliveries d
join public.keyflow_applications app on app.id = d.application_id
join public.keyflow_activities a on a.id = app.activity_id
join public.keyflow_badges b on b.game_name = a.game_name
where app.answerer_id is not null
on conflict (answerer_id, badge_id) do nothing;

alter table public.keyflow_badges enable row level security;
alter table public.keyflow_user_badges enable row level security;

create policy "keyflow public badge read" on public.keyflow_badges for select to anon, authenticated using (true);
create policy "keyflow public user badge read" on public.keyflow_user_badges for select to anon, authenticated using (true);
