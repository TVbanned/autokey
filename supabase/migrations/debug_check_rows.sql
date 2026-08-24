-- 排查：确认行号映射表是否有数据、以及最近几条问题运营记录的 id / zhihu_url / processed。
select * from public.keyflow_tencent_docs_rows order by updated_at desc limit 20;
select id, title, zhihu_url, processed, created_at from public.keyflow_daily_questions order by created_at desc limit 5;
