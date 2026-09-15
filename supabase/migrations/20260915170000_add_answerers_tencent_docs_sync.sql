-- Gamejourney 答主信息腾讯文档同步目标。
update public.keyflow_tencent_docs_sync
set sheets = jsonb_set(
  sheets,
  '{keyflow_answerers}',
  '{"book":"DWHRCbnhBQXB6RnJ4","sheet":"BB08J2"}'::jsonb,
  true
),
updated_at = now()
where id = 1;
