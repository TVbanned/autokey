-- 合并答主看板「今日创作/提问投稿」后的后端调整：
-- 1) 识别出的「回答」统一写入 keyflow_daily_submissions（答主日常投稿），管理员录入的回答
--    answerer_id 为空，故放宽 NOT NULL 约束。
-- 2) 回答不再写入原文档 sheet2：keyflow_tencent_docs_sync.sheets 移除废弃的
--    keyflow_daily_questions:answer 子表配置（回答改由 keyflow_daily_submissions 触发器
--    自动同步至 Gamejourney 每日投稿文档）。
-- 3) 「日常问题运营」后台列表只展示问题（回答已分流至「答主日常投稿」分页）。

alter table public.keyflow_daily_submissions
  alter column answerer_id drop not null;

update public.keyflow_tencent_docs_sync
set sheets = sheets - 'keyflow_daily_questions:answer',
    updated_at = now()
where id = 1;

create or replace function public.keyflow_admin_daily_questions(p_token uuid)
returns setof public.keyflow_daily_questions
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.keyflow_is_admin(p_token) then
    raise exception '管理员权限不足';
  end if;

  return query
  select q.*
  from public.keyflow_daily_questions q
  where q.content_type = 'question'
  order by q.created_at desc;
end;
$$;
