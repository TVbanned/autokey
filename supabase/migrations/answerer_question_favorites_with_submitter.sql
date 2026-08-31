-- 答主看板「游戏问题集散中心」：收藏问题列表关联日常问题投稿人。
-- 答主通过「今日创作/提问投稿」提交的问题进入 keyflow_daily_questions（带 answerer_id），
-- 管理员批量收藏后进入 keyflow_zhihu_question_favorites（source='daily'）。
-- 此处按 zhihu_url 关联 daily_questions 取最近一条投稿人，标注「来自 @xxx 的提问」。

drop function if exists public.keyflow_answerer_zhihu_question_favorites(uuid);

create or replace function public.keyflow_answerer_zhihu_question_favorites(p_answerer_id uuid)
returns table (
  id uuid,
  zhihu_url text,
  title text,
  source text,
  created_at timestamptz,
  updated_at timestamptz,
  answerer_id uuid,
  answerer_name text
)
language sql stable security definer set search_path = public
as $$
  select f.id, f.zhihu_url, f.title, f.source, f.created_at, f.updated_at,
         dq.answerer_id,
         a.zhihu_name as answerer_name
  from public.keyflow_zhihu_question_favorites f
  left join lateral (
    select q.answerer_id
    from public.keyflow_daily_questions q
    where q.zhihu_url = f.zhihu_url
      and q.answerer_id is not null
    order by q.created_at desc
    limit 1
  ) dq on true
  left join public.keyflow_answerers a on a.id = dq.answerer_id
  order by f.created_at desc
  limit 20;
$$;

revoke all on function public.keyflow_answerer_zhihu_question_favorites(uuid) from public;
grant execute on function public.keyflow_answerer_zhihu_question_favorites(uuid) to anon;
