-- 更新腾讯文档访问令牌（30 天令牌，用户每次手工换取后贴进来）。
-- 本次：签发 2026-09-28 09:14:40（北京时间），有效期至 2026-10-28 09:14:40（北京时间）。
-- 已同步位置：本文件 + public.keyflow_tencent_docs_sync 单行表 + src/App.jsx 的
--             TENCENT_TOKEN_EXPIRES_AT（后台「腾讯文档令牌提醒」弹窗）。
update public.keyflow_tencent_docs_sync
set access_token = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJjbHQiOiIyNWU5ZDhjYzRjZTg0Y2MzYTYxYzljNzQ5ZTIxOGZiNyIsInR5cCI6MSwiZXhwIjoxNzkzMTUwMDgwLjY0NDUyMSwiaWF0IjoxNzkwNTU4MDgwLjY0NDUyMSwic3ViIjoiNzA2Y2RkYTUxMzAxNDk1N2JhNmYzOWY2OTRhM2I1NTcifQ.a7sNwhE5ClFLutIoyuzkiw5nMWIdp3hIOG_xDAdatI0',
    token_expires_at = to_timestamp(1793150080.644521),
    updated_at = now()
where id = 1;
