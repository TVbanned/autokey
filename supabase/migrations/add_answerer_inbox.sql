-- 给收件箱表添加 to_id，支持管理员向答主发送私信
alter table public.keyflow_inbox add column if not exists to_id uuid references public.keyflow_answerers(id) on delete cascade;
create index if not exists keyflow_inbox_to_id_idx on public.keyflow_inbox(to_id);
