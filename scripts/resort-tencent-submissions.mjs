// 腾讯文档「答主日常投稿 / 全部活动投稿 / 日常问题」全量重排（本机手动触发）。
//
// 用法：node autokey/scripts/resort-tencent-submissions.mjs [表名 ...]
//   不带参数 = 三张表都重排
//   可指定 public.keyflow_daily_submissions / keyflow_deliveries / keyflow_daily_questions
//
// ⚠️ 2026-10-15 改法（重要）：本脚本不再自己读库 + 写文档，改为直接调用已部署的
//   edge function `sync-tencent-docs`（函数内部分页读全量、分页写文档）。
//   旧版有两个坑：
//   1) 用 REST `?limit=100000` 读全量，实测仍被 Supabase 夹到 1000 行
//      （PostgREST db-max-rows），表一过千行就会把文档写残；
//   2) 它写的「答主日常投稿」只有 5 列、没有第 6 列「来源」，跑一次就会盖掉来源列。
//   排查记录：codex-trae-sync/change-20261015-daily-submissions-read-cap.md

const SUPABASE_URL = process.env.VITE_SUPABASE_URL || 'https://ihbegkpvqrtycsfmklag.supabase.co';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImloYmVna3B2cXJ0eWNzZm1rbGFnIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4NDA5OTI4NCwiZXhwIjoyMDk5Njc1Mjg0fQ.oegq8B-i8TWk8kXwFdA44_UKwjYnhojhz8F4ymGxYp4';

const ALL_TABLES = ['keyflow_daily_submissions', 'keyflow_deliveries', 'keyflow_daily_questions'];
const requested = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const tables = requested.length ? requested : ALL_TABLES;

for (const table of tables) {
  if (!ALL_TABLES.includes(table)) {
    console.error(`跳过未知表：${table}（可用的表：${ALL_TABLES.join(' / ')}）`);
    process.exitCode = 1;
    continue;
  }
  const started = Date.now();
  const resp = await fetch(`${SUPABASE_URL}/functions/v1/sync-tencent-docs`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: SERVICE_KEY,
      Authorization: 'Bearer ' + SERVICE_KEY,
    },
    // record 只是让函数走到「新增 → 全量重排」分支的哑值，函数会按表重新读全量并重排
    body: JSON.stringify({ type: 'INSERT', table, record: { id: '00000000-0000-0000-0000-000000000000' } }),
  });
  const text = await resp.text();
  console.log(`${table}: HTTP ${resp.status} ${text} (${((Date.now() - started) / 1000).toFixed(1)}s)`);
  if (!resp.ok) process.exitCode = 1;
}

console.log('DONE');
