const BOOK = '300000000$XQpxEHiSksps';
const CLIENT_ID = '25e9d8cc4ce84cc3a61c9c749e218fb7';
const OPEN_ID = '706cdda513014957ba6f39f694a3b557';
const ACCESS_TOKEN = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJjbHQiOiIyNWU5ZDhjYzRjZTg0Y2MzYTYxYzljNzQ5ZTIxOGZiNyIsInR5cCI6MSwiZXhwIjoxNzg3ODk0Mzk2LjI1NTEwMSwiaWF0IjoxNzg1MzAyMzk2LjI1NTEwMSwic3ViIjoiNzA2Y2RkYTUxMzAxNDk1N2JhNmYzOWY2OTRhM2I1NTcifQ.orwl3IxSHOBrVaIczPKztvwdVDVSALhQoCjG6n3tyJA';

const SUPABASE_URL = 'https://ihbegkpvqrtycsfmklag.supabase.co';
const SERVICE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImloYmVna3B2cXJ0eWNzZm1rbGFnIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4NDA5OTI4NCwiZXhwIjoyMDk5Njc1Mjg0fQ.oegq8B-i8TWk8kXwFdA44_UKwjYnhojhz8F4ymGxYp4';

const tdocsHeaders = {
  'Content-Type': 'application/json',
  'Access-Token': ACCESS_TOKEN,
  'Client-Id': CLIENT_ID,
  'Open-Id': OPEN_ID,
};
const sbHeaders = {
  'apikey': SERVICE_KEY,
  'Authorization': `Bearer ${SERVICE_KEY}`,
  'Content-Type': 'application/json',
};

function fmt(v) {
  if (v == null) return '';
  const d = new Date(String(v));
  if (isNaN(d.getTime())) return String(v);
  return d.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
}

async function putSheet(sheetID, values) {
  const range = `${sheetID}!A1:D${values.length}`;
  const url = `https://docs.qq.com/openapi/sheetbook/v2/${BOOK}/values/${range}`;
  const resp = await fetch(url, { method: 'PUT', headers: tdocsHeaders, body: JSON.stringify({ values }) });
  const text = await resp.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: resp.status, json };
}

const HEADER = ['创建时间', '标题', '知乎链接', '状态'];

// 1. 读取全部记录
const q = await fetch(`${SUPABASE_URL}/rest/v1/keyflow_daily_questions?select=id,title,zhihu_url,content_type,processed,created_at`, { headers: sbHeaders });
const records = await q.json();
console.log('总记录数:', Array.isArray(records) ? records.length : records);

const questions = (records || []).filter((r) => r.content_type !== 'answer');
const answers = (records || []).filter((r) => r.content_type === 'answer');

// 倒序排序：先按创建时间倒序，同一批时间相同时按知乎内容 ID 倒序（ID 越大越新）
const contentId = (r) => Number((r.zhihu_url || '').match(/(\d+)\/?$/)?.[1] || 0);
const byNewest = (a, b) =>
  (new Date(b.created_at) - new Date(a.created_at)) || (contentId(b) - contentId(a));
questions.sort(byNewest);
answers.sort(byNewest);

function toRows(list) {
  return list.map((r) => [fmt(r.created_at), r.title ?? '', r.zhihu_url ?? '', r.processed ? '已处理' : '未处理']);
}

const sheetMap = [
  { sheetID: 'BB08J2', table_name: 'keyflow_daily_questions', rows: questions },
  { sheetID: '9PKN2L', table_name: 'keyflow_daily_questions:answer', rows: answers },
];

for (const s of sheetMap) {
  const values = [HEADER, ...toRows(s.rows)];
  const r = await putSheet(s.sheetID, values);
  console.log(`=== 写 ${s.sheetID} (${s.rows.length} 条) ===`, r.status, JSON.stringify(r.json));
}

// 2. 重建映射
for (const s of sheetMap) {
  const payload = s.rows.map((r, i) => ({
    table_name: s.table_name,
    record_id: r.id,
    row: 2 + i,
  }));
  if (payload.length === 0) continue;
  const r = await fetch(`${SUPABASE_URL}/rest/v1/keyflow_tencent_docs_rows`, {
    method: 'POST',
    headers: { ...sbHeaders, 'Prefer': 'resolution=merge-duplicates' },
    body: JSON.stringify(payload),
  });
  console.log(`=== 重建映射 ${s.table_name} (${payload.length} 条) ===`, r.status);
}
console.log('DONE');
