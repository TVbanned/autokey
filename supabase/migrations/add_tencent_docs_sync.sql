-- 腾讯文档同步配置（单行表）。由 Edge Function sync-tencent-docs 用 service role 读写。
-- ponytail: client_secret 明文存于库中，仅 service role 可读，与 SUPABASE_SERVICE_ROLE_KEY 同级风险；
--           如需更严，可改为 Supabase Vault 或 Edge Function secrets 存储。
create table if not exists public.keyflow_tencent_docs_sync (
  id integer primary key default 1 check (id = 1),
  client_id text not null default '',
  client_secret text not null default '',
  open_id text not null default '',
  access_token text not null default '',
  refresh_token text not null default '',
  token_expires_at timestamptz,
  -- sheets: { "<supabase表名>": { "book": "在线表格bookID", "sheet": "子表ID", "row": 下一行行号 } }
  sheets jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.keyflow_tencent_docs_sync enable row level security;
revoke all on table public.keyflow_tencent_docs_sync from anon, authenticated;
