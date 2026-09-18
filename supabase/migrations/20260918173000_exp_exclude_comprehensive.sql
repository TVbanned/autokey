-- 经验口径修正（2026-09-18 晚）：
--   综合活动不属于「测评活动」，不该走「已完成活动 300 经验」这条规则。
--   综合活动的正确口径 = 命中题库的投稿累计满 min_submission_count（当前 20 篇）→ 发活动完成奖励（金币 + 经验），
--   没命中题库的稿子不算活动内容。
--
-- 改前（bug）：② 「已完成活动 300」和 ②' 「多交 40/篇」把综合活动的交付也算进去了，
--   于是「在综合活动申领页交一篇（哪怕是不命中题库的专栏文章）」白拿 300 经验。
--   实测：全站综合活动交付 21 篇、涉及 7 位答主，每人多拿 300。
--
-- 改后：
--   ① 报名 50/活动（不变，报名行为，与稿件无关）
--   ② 已完成活动 300：只认 activity_type <> 'comprehensive'
--   ②' 多交 40/篇：同样只认非综合活动
--   ⑤ 综合活动投稿 40/篇：投稿框那张表照旧 + 综合活动的交付也按 40/篇（等价于「日常内容」），
--      但**不计入活动完成**：完成进度只由命中题库的稿件决定，
--      满 min_submission_count 后由 keyflow_activity_completion_rewards 发金币 + 经验（不受本次改动影响）。
--
-- 说明：展示侧不受影响——外显经验 = 切换基线 + 之后新增，真实值回落不会让答主看到数字下降。

begin;

create or replace function public.keyflow_answerer_exp(p_answerer_id uuid)
returns bigint
language sql
stable
set search_path = public
as $$
  select
    -- ① 已参与活动：报名就算（含未入选/被拒，按活动去重）
    (select count(distinct activity_id) * 50 from keyflow_applications
      where answerer_id = p_answerer_id)
    -- ② 已完成活动：交稿就算（按有交付的活动去重）——只认测评活动，综合活动不算
    + (select count(distinct ap.activity_id) * 300
         from keyflow_applications ap
         join keyflow_activities a on a.id = ap.activity_id
         join keyflow_deliveries d on d.application_id = ap.id
        where ap.answerer_id = p_answerer_id
          and coalesce(a.activity_type, 'game') <> 'comprehensive')
    -- ②补充：同一测评活动多交的内容，第 2 篇起按日常投稿 40/篇
    + (select greatest(0, count(*) - count(distinct ap.activity_id)) * 40
         from keyflow_applications ap
         join keyflow_activities a on a.id = ap.activity_id
         join keyflow_deliveries d on d.application_id = ap.id
        where ap.answerer_id = p_answerer_id
          and coalesce(a.activity_type, 'game') <> 'comprehensive')
    -- ③ 已投稿问题：20/题
    + (select coalesce(sum(xp_value), 0) from keyflow_daily_questions
       where answerer_id = p_answerer_id)
    -- ④ 日常内容：40/个
    + (select coalesce(sum(xp_value), 0) from keyflow_daily_submissions
       where answerer_id = p_answerer_id)
    -- ⑤ 综合活动投稿：投稿框那张表按 40/个；申领页交付也算「日常内容」40/篇（但不计活动完成）
    + (select coalesce(sum(xp_value), 0) from keyflow_comprehensive_submissions
       where answerer_id = p_answerer_id)
    + (select count(*) * 40
         from keyflow_applications ap
         join keyflow_activities a on a.id = ap.activity_id
         join keyflow_deliveries d on d.application_id = ap.id
        where ap.answerer_id = p_answerer_id
          and coalesce(a.activity_type, 'game') = 'comprehensive')
    -- ⑥ 综合活动完成奖励经验（命中满 N 篇时一次性发放）
    + (select coalesce(sum(exp_amount), 0) from keyflow_activity_completion_rewards
       where answerer_id = p_answerer_id);
$$;

grant execute on function public.keyflow_answerer_exp(uuid) to anon, authenticated;

commit;

-- 自检：抽样看改动前后的差值（应等于「综合活动交付篇数 × 300 − 篇数 × 40」）
select jsonb_build_object(
  'shuangyu_exp', public.keyflow_answerer_exp('99924610-3795-4f70-8e34-29559e711120'),
  'shuangyu_comp_deliveries', (
    select count(*) from public.keyflow_applications ap
    join public.keyflow_activities a on a.id = ap.activity_id
    join public.keyflow_deliveries d on d.application_id = ap.id
    where ap.answerer_id = '99924610-3795-4f70-8e34-29559e711120'
      and coalesce(a.activity_type, 'game') = 'comprehensive')
) as applied;
