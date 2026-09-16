-- 2.0 上线前补两条：
--   1) 经验规则②补充：一个活动交多篇时，第 1 篇按「完成活动 300」计，
--      第 2 篇起按「日常投稿 40/篇」计（keyflow_deliveries 多出来的条数 × 40）。
--   2) 新增 keyflow_level_economy()：一次返回 {等级: 每日活跃金币}，
--      口径 = keyflow_level_config.daily_coins × keyflow_economy_config.coin_scale_s
--      （即 keyflow_daily_coins(level)）。前台「每日活跃产出」用它，避免前端硬编码 2000×等级/30 且漏乘系数。

begin;

create or replace function public.keyflow_answerer_exp(p_answerer_id uuid)
returns bigint
language sql stable
set search_path = public
as $$
  select
    -- ① 已参与活动：报名就算（含未入选/被拒，按活动去重）
    (select count(distinct activity_id) * 50 from keyflow_applications
      where answerer_id = p_answerer_id)
    -- ② 已完成活动：交稿就算（按有交付的活动去重，一个活动 300）
    + (select count(distinct a.activity_id) * 300 from keyflow_applications a
        join keyflow_deliveries d on d.application_id = a.id
       where a.answerer_id = p_answerer_id)
    -- ②补充：同一活动多交的内容，第 2 篇起按日常投稿 40/篇
    + (select greatest(0, count(*) - count(distinct a.activity_id)) * 40 from keyflow_applications a
        join keyflow_deliveries d on d.application_id = a.id
       where a.answerer_id = p_answerer_id)
    -- ③ 已投稿问题：20/题
    + (select coalesce(sum(xp_value), 0) from keyflow_daily_questions
       where answerer_id = p_answerer_id)
    -- ④ 日常内容：40/个
    + (select coalesce(sum(xp_value), 0) from keyflow_daily_submissions
       where answerer_id = p_answerer_id)
    -- ⑤ 综合活动投稿（按日常内容 40/个）+ 完成奖励经验
    + (select coalesce(sum(xp_value), 0) from keyflow_comprehensive_submissions
       where answerer_id = p_answerer_id)
    + (select coalesce(sum(exp_amount), 0) from keyflow_activity_completion_rewards
       where answerer_id = p_answerer_id);
$$;

create or replace function public.keyflow_level_economy()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(jsonb_object_agg(c.level::text, public.keyflow_daily_coins(c.level)), '{}'::jsonb)
  from public.keyflow_level_config c;
$$;

grant execute on function public.keyflow_level_economy() to anon, authenticated;

commit;

select jsonb_build_object(
  'lv5_daily_coins', public.keyflow_level_economy() ->> '5',
  'lv1_daily_coins', public.keyflow_level_economy() ->> '1',
  'map_size', (select count(*) from public.keyflow_level_config)
) as applied;
