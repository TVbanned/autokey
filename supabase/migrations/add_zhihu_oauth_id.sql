-- 重新添加 zhihu_id 列用于知乎 OAuth 登录标识
-- nullable：手动报名不需要，OAuth 登录后自动填充
alter table public.keyflow_applications
  add column if not exists zhihu_id text;

-- 防重复：同一活动同一知乎用户只能报名一次
-- PostgreSQL unique 中 NULL 不冲突，手动报名不受影响
create unique index if not exists keyflow_applications_activity_zhihu_id_uniq
  on public.keyflow_applications (activity_id, zhihu_id)
  where zhihu_id is not null;
