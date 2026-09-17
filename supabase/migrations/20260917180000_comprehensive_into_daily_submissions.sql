-- 综合活动命中投稿并入「答主日常投稿」（2026-09-17）
-- 背景：命中综合活动题库的投稿单独进 keyflow_comprehensive_submissions，原来只在【综合活动投稿】页可见，
--       运营的日常审核/腾讯文档表里看不到。现在两张表在「答主日常投稿」页合并展示（前端按 source 写回各自表），
--       并按提交时间一起重排到同一张腾讯文档表，新增第 6 列「来源」区分（日常投稿 / 综合活动 · 活动名）。
-- 说明：合并在展示层做（不改数据、不复制行），所以命中计数、经验、每日额度都不受影响，历史投稿无需回填数据。

begin;

-- 合并视图里的「精华」开关对两种来源共用，给综合活动投稿补一个 featured 列
alter table public.keyflow_comprehensive_submissions
  add column if not exists featured boolean not null default false;

-- 复用既有 webhook 触发器函数：INSERT/UPDATE 都会 POST 到 sync-tencent-docs，
-- 由它重排「答主日常投稿」那张表（函数里把 keyflow_comprehensive_submissions 映射到同一张 sheet）。
drop trigger if exists trg_sync_tencent_comprehensive_submissions on public.keyflow_comprehensive_submissions;
create trigger trg_sync_tencent_comprehensive_submissions
after insert on public.keyflow_comprehensive_submissions
for each row execute function public.sync_to_tencent_docs();

drop trigger if exists trg_sync_tencent_comprehensive_submissions_upd on public.keyflow_comprehensive_submissions;
create trigger trg_sync_tencent_comprehensive_submissions_upd
after update on public.keyflow_comprehensive_submissions
for each row execute function public.sync_to_tencent_docs();

commit;
