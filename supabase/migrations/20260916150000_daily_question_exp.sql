-- 提问投稿计入真实经验：20 经验/题（看板文案口径「已投稿问题 · 20 经验/题」）。
-- 口径：**只对新增提问生效**。历史 151 条提问保持 0 经验，避免上线前凭空改变存量等级
--       （测算：若回填会 +3020 经验、3 位答主直接升级）。要回填时执行：
--       update public.keyflow_daily_questions set xp_value = 20 where xp_value = 0;

begin;

do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'keyflow_daily_questions' and column_name = 'xp_value'
  ) then
    alter table public.keyflow_daily_questions
      add column xp_value integer not null default 20;
    -- 历史提问不回填：上线前不动存量经验/等级
    update public.keyflow_daily_questions set xp_value = 0;
  end if;
end $$;

alter table public.keyflow_daily_questions
  drop constraint if exists keyflow_daily_questions_xp_value_check;
alter table public.keyflow_daily_questions
  add constraint keyflow_daily_questions_xp_value_check check (xp_value >= 0);

-- 经验口径：入选活动 + 交付 + 日常投稿 + 活动投稿 + 活动完成奖励 + 提问投稿
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
    + (select coalesce(sum(xp_value), 0) from keyflow_daily_questions
       where answerer_id = p_answerer_id)
    + (select coalesce(sum(exp_amount), 0) from keyflow_activity_completion_rewards
       where answerer_id = p_answerer_id);
$$;

commit;
