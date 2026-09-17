-- 综合活动「完成度」人工补记（2026-09-17）：
-- 需要给个别答主补/扣参与次数时，不改投稿数据（避免误发经验、金币、活跃），
-- 而是往 keyflow_activity_manual_hits 记一笔，统一命中计数会把这一笔加进去。
-- 用法示例（+2 次）：insert into keyflow_activity_manual_hits (activity_id, answerer_id, hits, note)
--                     values ('<活动id>', '<答主id>', 2, '运营补记：xxx');
-- 撤销：delete from keyflow_activity_manual_hits where id = '<行id>';

begin;

create table if not exists public.keyflow_activity_manual_hits (
  id uuid primary key default gen_random_uuid(),
  activity_id uuid not null references public.keyflow_activities(id) on delete cascade,
  answerer_id uuid not null references public.keyflow_answerers(id) on delete cascade,
  hits integer not null check (hits <> 0),
  note text not null default '',
  created_at timestamptz not null default now(),
  unique (activity_id, answerer_id)
);

create index if not exists keyflow_activity_manual_hits_answerer_idx
  on public.keyflow_activity_manual_hits (answerer_id);

-- 只由服务端函数读取，不给前端开策略
alter table public.keyflow_activity_manual_hits enable row level security;

-- 统一命中计数 = 三张投稿表命中数 + 人工补记
create or replace function public.keyflow_answerer_activity_hits(p_answerer_id uuid, p_activity_id uuid)
returns integer
language sql
stable
security definer
set search_path = public
as $$
  select (
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
     and q.question_id = public.keyflow_extract_zhihu_question_id(s.article_url)
  ) + coalesce((
    select sum(m.hits)::int from public.keyflow_activity_manual_hits m
    where m.activity_id = p_activity_id and m.answerer_id = p_answerer_id
  ), 0);
$$;

grant execute on function public.keyflow_answerer_activity_hits(uuid, uuid) to anon, authenticated;

-- 本次补记：鸦走道人 +2、韩信 +7（活动：9月 新游猎场）
insert into public.keyflow_activity_manual_hits (activity_id, answerer_id, hits, note)
values
  ('97606de9-6dd1-4a8f-bd65-d95cf0aff0b5', '588ecb80-cacf-41cb-9e02-c7e768f3902c', 2, '运营补记：综合活动完成度 +2'),
  ('97606de9-6dd1-4a8f-bd65-d95cf0aff0b5', '3688810e-c83a-46f9-b0d6-ffad7739d55f', 7, '运营补记：综合活动完成度 +7')
on conflict (activity_id, answerer_id) do update
  set hits = excluded.hits, note = excluded.note;

commit;

select jsonb_build_object(
  'yazou', public.keyflow_answerer_activity_hits('588ecb80-cacf-41cb-9e02-c7e768f3902c', '97606de9-6dd1-4a8f-bd65-d95cf0aff0b5'),
  'hanxin', public.keyflow_answerer_activity_hits('3688810e-c83a-46f9-b0d6-ffad7739d55f', '97606de9-6dd1-4a8f-bd65-d95cf0aff0b5')
) as after;
