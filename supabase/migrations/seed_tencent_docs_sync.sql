-- 初始化腾讯文档同步配置：写入三张业务表对应的腾讯文档 book/sheet 与当前 access_token。
-- 说明：access_token 为用户提供的 30 天令牌，token_expires_at 取自其 JWT exp
--       （本行随每次换令牌一起更新，当前有效期至 2026-10-28 09:14:40 北京时间；
--        换令牌时以 update_tencent_docs_token.sql 为准，两处要一起改）。
-- client_secret / refresh_token 暂缺，过期后需重新获取 access_token 手动更新，或走 OAuth 授权码流程补齐。
insert into public.keyflow_tencent_docs_sync (
  id, client_id, client_secret, open_id, access_token, refresh_token, token_expires_at, sheets
) values (
  1,
  '25e9d8cc4ce84cc3a61c9c749e218fb7',
  '',
  '706cdda513014957ba6f39f694a3b557',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJjbHQiOiIyNWU5ZDhjYzRjZTg0Y2MzYTYxYzljNzQ5ZTIxOGZiNyIsInR5cCI6MSwiZXhwIjoxNzkzMTUwMDgwLjY0NDUyMSwiaWF0IjoxNzkwNTU4MDgwLjY0NDUyMSwic3ViIjoiNzA2Y2RkYTUxMzAxNDk1N2JhNmYzOWY2OTRhM2I1NTcifQ.a7sNwhE5ClFLutIoyuzkiw5nMWIdp3hIOG_xDAdatI0',
  '',
  to_timestamp(1793150080.644521),
  '{
    "keyflow_daily_submissions": { "book": "300000000$XwFCxmZrIgSH", "sheet": "BB08J2", "row": 2 },
    "keyflow_deliveries":        { "book": "300000000$XFqoDiFkUgSd", "sheet": "BB08J2", "row": 2 },
    "keyflow_daily_questions":   { "book": "300000000$XQpxEHiSksps", "sheet": "BB08J2", "row": 2 }
  }'::jsonb
)
on conflict (id) do update set
  client_id = excluded.client_id,
  open_id = excluded.open_id,
  access_token = excluded.access_token,
  token_expires_at = excluded.token_expires_at,
  sheets = excluded.sheets,
  updated_at = now();
