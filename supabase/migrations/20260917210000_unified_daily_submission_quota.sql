-- 每日投稿额度口径统一（2026-09-17）
--
-- 规则（产品口径）：
--   1) 当天「日常投稿 + 综合活动投稿」合计条数先占用等级额度
--      （keyflow_level_config.daily_post_limit：Lv1=1 / Lv2=2 / Lv3-5=3 / Lv6-7=4 / Lv8+=5）；
--   2) 等级额度用完后，「命中综合活动题库」的稿件每天还可以再投
--      keyflow_comprehensive_daily_limit()（当前=3）篇；
--   3) 没命中活动题库的稿件只能用等级额度，不能动用额外额度。
--
-- 变更前口径（bug）：活动额度是独立 3 篇/天，和等级额度不互通，从第一篇活动投稿起就能用，
--   且未命中题库的稿件也照样占额度。答主「白翎GameUX」（Lv6）今天日常 2 篇 + 活动 3 条
--   （其中 1 条是同一链接重复入库）就被判「已投 3 篇」拦下，实际他连等级额度 4 篇都没用完。
--
-- 影响面：只改额度校验（三个触发器函数共用一个检查函数），不改 XP、金币、进度口径。

begin;

-- ---------- 1. 判定：这条链接的题目是否在「进行中的综合活动」题库里 ----------
create or replace function public.keyflow_article_hits_comprehensive_activity(p_url text)
returns boolean
language sql
stable
set search_path = public
as $$
  select exists (
    select 1
    from public.keyflow_activity_questions q
    join public.keyflow_activities a on a.id = q.activity_id
    where a.activity_type = 'comprehensive'
      and coalesce(a.status, '') <> 'completed'
      and q.question_id is not null
      and q.question_id = public.keyflow_extract_zhihu_question_id(p_url)
  );
$$;

-- ---------- 2. 统一的额度检查（命中活动题目 → 等级额度 + 额外额度；未命中 → 只有等级额度） ----------
create or replace function public.keyflow_enforce_submission_quota(p_answerer_id uuid, p_article_url text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_day date := (now() at time zone 'Asia/Shanghai')::date;
  v_level integer;
  v_base integer;
  v_extra integer := 0;
  v_cap integer;
  v_total integer;
begin
  if p_answerer_id is null then
    return;
  end if;

  -- 同一答主的投稿串行化：并发两次提交时，后一笔会等前一笔提交后再计数，不会再各自读到旧计数
  perform pg_advisory_xact_lock(hashtext(p_answerer_id::text));

  v_level := public.keyflow_display_current_level(p_answerer_id, v_day);
  v_base := coalesce(public.keyflow_daily_post_limit(v_level), 1);
  if public.keyflow_article_hits_comprehensive_activity(p_article_url) then
    v_extra := coalesce(public.keyflow_comprehensive_daily_limit(), 0);
  end if;
  v_cap := v_base + v_extra;

  select (select count(*) from public.keyflow_daily_submissions
           where answerer_id = p_answerer_id
             and (created_at at time zone 'Asia/Shanghai')::date = v_day)
       + (select count(*) from public.keyflow_comprehensive_submissions
           where answerer_id = p_answerer_id
             and (created_at at time zone 'Asia/Shanghai')::date = v_day)
    into v_total;

  if v_total >= v_cap then
    if v_extra > 0 then
      raise exception '今日投稿已达上限（Lv% 每天 % 篇 + 命中活动题目额外 % 篇），明天再来',
        v_level, v_base, v_extra;
    end if;
    raise exception '今日投稿已达上限（Lv% 每天 % 篇）；命中综合活动题目的投稿每天还可再投 % 篇',
      v_level, v_base, coalesce(public.keyflow_comprehensive_daily_limit(), 0);
  end if;
end;
$$;

-- ---------- 3. 三个触发器函数改用同一份检查 ----------
create or replace function public.keyflow_enforce_daily_submission_limit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.keyflow_enforce_submission_quota(new.answerer_id, new.article_url);
  return new;
end;
$$;

create or replace function public.keyflow_enforce_daily_submission_limit_v2()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.keyflow_enforce_submission_quota(new.answerer_id, new.article_url);
  new.xp_value := 40;
  return new;
end;
$$;

create or replace function public.keyflow_enforce_comprehensive_daily_limit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.keyflow_enforce_submission_quota(new.answerer_id, new.article_url);
  return new;
end;
$$;

commit;
