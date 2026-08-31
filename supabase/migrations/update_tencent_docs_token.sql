-- 更新腾讯文档访问令牌。令牌有效期至 2026-09-27 01:20:39（北京时间）。
update public.keyflow_tencent_docs_sync
set access_token = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJjbHQiOiIyNWU5ZDhjYzRjZTg0Y2MzYTYxYzljNzQ5ZTIxOGZiNyIsInR5cCI6MSwiZXhwIjoxNzkwNTA4ODM5LjA0NzE0MTgsImlhdCI6MTc4NzkxNjgzOS4wNDcxNDE4LCJzdWIiOiI3MDZjZGRhNTEzMDE0OTU3YmE2ZjM5ZjY5NGEzYjU1NyJ9.TcUI_DCmx8aGQmrbVLWDWPWaOg_2f56teq3zU9VxiyE',
    token_expires_at = to_timestamp(1790508839.0471418),
    updated_at = now()
where id = 1;
