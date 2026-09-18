-- 投稿逻辑修正（2026-09-18）
-- 依据：codex-trae-sync/bugcheck-20260918-xinyou-liechang-answerer-feedback.md
-- 存档：codex-trae-sync/投稿逻辑0918存档/（改动前的线上函数定义 + 两张投稿表数据快照）
--
-- 修的是什么：
--   ① 活动进度按「行数」计：同一篇稿件重复入库（今日投稿与活动页各投一次、连点）
--      或跨表重复（日常投稿表 + 综合活动投稿表各一条）→ 进度虚增。
--      实测「9月 新游猎场」：43 位答主、计入行数 163、去重作品 142、虚增 21。
--   ② 人工补记 keyflow_activity_manual_hits 叠加在自动命中之上 → 与后来自动读到的命中重合
--      （韩信 +7、鸦走道人 +2 就是这么叠上去的）。
--   ③ 两张投稿表没有唯一约束，前端只有连点锁，防不住两个入口分别投。
--
-- 改完的口径：
--   活动进度 = max(自动命中去重数, 人工补记数)
--     · 自动命中 = 三张表（日常投稿 / 综合活动投稿 / 测评交付）里命中该活动题库的「不同题目」数，
--       同一活动同一题目只算 1 次（重复入库不再影响进度）。
--     · 人工补记 = 运营认定的完成度下限，不再当增量叠加；要额外加就把这个值直接写成目标数。
--   经验/金币口径不动：单题奖励仍按 (activity_id, question_id, answerer_id) 去重，完成奖励仍只发一次。
--
-- 回滚：见 codex-trae-sync/投稿逻辑0918存档/README.md（functions-before.sql 可整段回放）。

begin;

-- ---------- 1. 命中口径：自动命中按题目去重 + 人工补记取下限 ----------
create or replace function public.keyflow_answerer_activity_hits(p_answerer_id uuid, p_activity_id uuid)
returns integer
language sql
stable
security definer
set search_path = public
as $$
  select greatest(
    (
      select count(distinct q.question_id)::int
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
    ),
    coalesce((
      select sum(m.hits)::int from public.keyflow_activity_manual_hits m
      where m.activity_id = p_activity_id and m.answerer_id = p_answerer_id
    ), 0)
  );
$$;

comment on function public.keyflow_answerer_activity_hits(uuid, uuid) is
  '活动完成度 = max(自动命中题目去重数, 人工补记下限)。2026-09-18 前是「行数 + 人工补记」，重复入库会虚增。';

grant execute on function public.keyflow_answerer_activity_hits(uuid, uuid) to anon, authenticated;

-- 对账用：把「自动命中 / 人工补记 / 最终值」拆开，方便运营判断手工补记该不该改
create or replace function public.keyflow_activity_hits_breakdown(p_answerer_id uuid, p_activity_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  with s as (
    select ds.article_url from public.keyflow_daily_submissions ds where ds.answerer_id = p_answerer_id
    union all
    select cs.article_url from public.keyflow_comprehensive_submissions cs where cs.answerer_id = p_answerer_id
    union all
    select d.article_url from public.keyflow_deliveries d
      join public.keyflow_applications ap on ap.id = d.application_id
     where ap.answerer_id = p_answerer_id
  ), auto as (
    select count(distinct q.question_id)::int as n
    from s
    join public.keyflow_activity_questions q
      on q.activity_id = p_activity_id
     and q.question_id is not null
     and q.question_id = public.keyflow_extract_zhihu_question_id(s.article_url)
  ), manual as (
    select coalesce(sum(m.hits), 0)::int as n
    from public.keyflow_activity_manual_hits m
    where m.activity_id = p_activity_id and m.answerer_id = p_answerer_id
  )
  select jsonb_build_object('auto', auto.n, 'manual', manual.n, 'total', greatest(auto.n, manual.n))
  from auto, manual;
$$;

comment on function public.keyflow_activity_hits_breakdown(uuid, uuid) is
  '活动完成度对账：{auto 自动命中题目数, manual 人工补记, total 最终值}。';

grant execute on function public.keyflow_activity_hits_breakdown(uuid, uuid) to anon, authenticated;

-- ---------- 2. 清理已重复入库的行 + 加唯一约束 ----------
-- 2.1 备份表（只建一次，重复执行本迁移不会覆盖已有备份）
create table if not exists public.keyflow_comprehensive_submissions_dup_backup_20260918
  as select * from public.keyflow_comprehensive_submissions where false;
create table if not exists public.keyflow_daily_submissions_dup_backup_20260918
  as select * from public.keyflow_daily_submissions where false;

-- 2.2 找出重复行：综合活动投稿按「答主 + 活动 + 链接」，日常投稿按「答主 + 链接」，每组保留最早一条
create temporary table tmp_dup_comp on commit drop as
select c.*
from public.keyflow_comprehensive_submissions c
join (
  select id from (
    select id, row_number() over (
      partition by answerer_id, activity_id, article_url
      order by created_at asc, id asc
    ) as rn
    from public.keyflow_comprehensive_submissions
  ) t where t.rn > 1
) d on d.id = c.id;

create temporary table tmp_dup_daily on commit drop as
select ds.*
from public.keyflow_daily_submissions ds
join (
  select id from (
    select id, row_number() over (
      partition by answerer_id, article_url
      order by created_at asc, id asc
    ) as rn
    from public.keyflow_daily_submissions
    where answerer_id is not null
  ) t where t.rn > 1
) d on d.id = ds.id;

insert into public.keyflow_comprehensive_submissions_dup_backup_20260918 select * from tmp_dup_comp;
insert into public.keyflow_daily_submissions_dup_backup_20260918 select * from tmp_dup_daily;

-- 2.3 删行前先把受影响答主的经验下限抬到「当前展示值」，保证删重复行不削减任何人的经验数字
update public.keyflow_answerers a
   set exp_floor = greatest(a.exp_floor, public.keyflow_answerer_exp(a.id))
 where a.id in (select answerer_id from tmp_dup_comp)
    or a.id in (select answerer_id from tmp_dup_daily);

-- 2.4 删除重复行
delete from public.keyflow_comprehensive_submissions c using tmp_dup_comp d where c.id = d.id;
delete from public.keyflow_daily_submissions ds using tmp_dup_daily d where ds.id = d.id;

-- 2.5 唯一约束兜底：以后重复入库直接报 23505，前端按「该链接已投过稿」提示
create unique index if not exists keyflow_comprehensive_submissions_answerer_activity_url_key
  on public.keyflow_comprehensive_submissions (answerer_id, activity_id, article_url);
create unique index if not exists keyflow_daily_submissions_answerer_url_key
  on public.keyflow_daily_submissions (answerer_id, article_url);

commit;

-- 执行结果自检
select jsonb_build_object(
  'comp_dup_backed_up', (select count(*) from public.keyflow_comprehensive_submissions_dup_backup_20260918),
  'daily_dup_backed_up', (select count(*) from public.keyflow_daily_submissions_dup_backup_20260918),
  'comp_rows_left', (select count(*) from public.keyflow_comprehensive_submissions),
  'daily_rows_left', (select count(*) from public.keyflow_daily_submissions),
  'xylc_hits_hanxin', public.keyflow_answerer_activity_hits('3688810e-c83a-46f9-b0d6-ffad7739d55f', '97606de9-6dd1-4a8f-bd65-d95cf0aff0b5'),
  'xylc_breakdown_hanxin', public.keyflow_activity_hits_breakdown('3688810e-c83a-46f9-b0d6-ffad7739d55f', '97606de9-6dd1-4a8f-bd65-d95cf0aff0b5'),
  'xylc_hits_yazou', public.keyflow_answerer_activity_hits('588ecb80-cacf-41cb-9e02-c7e768f3902c', '97606de9-6dd1-4a8f-bd65-d95cf0aff0b5'),
  'xylc_breakdown_yazou', public.keyflow_activity_hits_breakdown('588ecb80-cacf-41cb-9e02-c7e768f3902c', '97606de9-6dd1-4a8f-bd65-d95cf0aff0b5')
) as applied;
