-- 修复交付/日常投稿作品链接中的复制粘贴噪音。
-- 根因：答主填写作品链接时在 http 前混入空格/全角空格等不可见字符，
-- 导出到知乎「保量扶持」等批量接口时报 “url 非法”。
-- 处理：新增统一清洗函数 -> 清洗 keyflow_deliveries / keyflow_daily_submissions 存量数据。
-- 前端录入与导出已共用同一规则（src/zhihuUrl.js），历史数据由本迁移补齐。

create or replace function public.keyflow_strip_url_noise(p_url text)
returns text
language sql
immutable
as $$
  select regexp_replace(
    coalesce(p_url, ''),
    '[[:cntrl:][:space:]' || chr(160) || chr(8203) || chr(8204) || chr(8205) || chr(12288) || chr(65279) || ']',
    '',
    'g'
  );
$$;

update public.keyflow_deliveries
set article_url = public.keyflow_strip_url_noise(article_url)
where article_url is distinct from public.keyflow_strip_url_noise(article_url);

update public.keyflow_daily_submissions
set article_url = public.keyflow_strip_url_noise(article_url)
where article_url is distinct from public.keyflow_strip_url_noise(article_url);