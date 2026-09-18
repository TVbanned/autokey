-- 投稿数据（知乎侧表现）落库表（2026-09-18）
--
-- 背景：后台要新增「投稿数据」页，按时间区间看每条投稿在知乎侧的字数/曝光/阅读/点赞/评论并算 CTR。
--   知乎侧数据只在公司数据平台（datain CLI → sql-gateway）里，前端访问不到，
--   所以由 codex-trae-sync/sync-submission-metrics.ps1 每天同步到这张表，前端只读这张表。
--
-- 口径（与同步脚本一致）：
--   word_num                      字数（内容核心宽表，取最新快照）
--   exposure                      曝光 = 投稿日至今 APP 端卡片曝光按天相加（app_cardshow_cnt_1d）
--   page_show                     页面曝光（同窗口相加，备用口径）
--   pv                            阅读 = 同窗口 PV 按天相加（pv_1d）
--   pv_td                         内容累计 PV（最新快照的 pv_td，含投稿前）
--   upvote / comment / collect    累计点赞 / 评论 / 收藏（最新快照的 *_td）
--   CTR = pv / exposure（前端计算，分母为 0 时显示 —）
-- 数据源表：dw_community.dws_content_core_wide_pt（快照分区 p_date，T+1）

begin;

create table if not exists public.keyflow_submission_metrics (
  content_token text primary key,
  content_type text,
  content_id bigint,
  author_name text,
  publish_date date,
  content_level integer,
  word_num integer,
  exposure bigint not null default 0,
  page_show bigint not null default 0,
  pv bigint not null default 0,
  pv_td bigint not null default 0,
  upvote bigint not null default 0,
  comment bigint not null default 0,
  collect bigint not null default 0,
  window_start date,
  window_end date,
  synced_at timestamptz not null default now()
);

create index if not exists keyflow_submission_metrics_synced_idx
  on public.keyflow_submission_metrics (synced_at desc);

alter table public.keyflow_submission_metrics enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'keyflow_submission_metrics'
      and policyname = 'keyflow public submission metrics access'
  ) then
    create policy "keyflow public submission metrics access"
      on public.keyflow_submission_metrics
      for all to anon, authenticated using (true) with check (true);
  end if;
end $$;

grant all on public.keyflow_submission_metrics to anon, authenticated;

commit;

select jsonb_build_object(
  'table_exists', exists (select 1 from information_schema.tables where table_schema = 'public' and table_name = 'keyflow_submission_metrics'),
  'rows', (select count(*) from public.keyflow_submission_metrics)
) as applied;
