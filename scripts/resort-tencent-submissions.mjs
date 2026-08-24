const CLIENT_ID = '25e9d8cc4ce84cc3a61c9c749e218fb7';
const OPEN_ID = '706cdda513014957ba6f39f694a3b557';
const ACCESS_TOKEN = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJjbHQiOiIyNWU5ZDhjYzRjZTg0Y2MzYTYxYzljNzQ5ZTIxOGZiNyIsInR5cCI6MSwiZXhwIjoxNzg3ODk0Mzk2LjI1NTEwMSwiaWF0IjoxNzg1MzAyMzk2LjI1NTEwMSwic3ViIjoiNzA2Y2RkYTUxMzAxNDk1N2JhNmYzOWY2OTRhM2I1NTcifQ.orwl3IxSHOBrVaIczPKztvwdVDVSALhQoCjG6n3tyJA';

const SUPABASE_URL = 'https://ihbegkpvqrtycsfmklag.supabase.co';
const SERVICE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImloYmVna3B2cXJ0eWNzZm1rbGFnIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4NDA5OTI4NCwiZXhwIjoyMDk5Njc1Mjg0fQ.oegq8B-i8TWk8kXwFdA44_UKwjYnhojhz8F4ymGxYp4';

const tdocHeaders = {
  'Content-Type': 'application/json',
  'Access-Token': ACCESS_TOKEN,
  'Client-Id': CLIENT_ID,
  'Open-Id': OPEN_ID,
};
const sbHeaders = { apikey: SERVICE_KEY, Authorization: 'Bearer ' + SERVICE_KEY };

const DELIVERY_STATUS = { pending: '待审', approved: '通过', revision_required: '需修改', rejected: '驳回' };

function fmt(v) {
  if (v == null) return '';
  const d = new Date(String(v));
  if (isNaN(d.getTime())) return String(v);
  return d.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
}

function colLetter(n) {
  let s = '';
  while (n > 0) { s = String.fromCharCode(65 + ((n - 1) % 26)) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

async function sbGet(path) {
  const r = await fetch(SUPABASE_URL + path, { headers: sbHeaders });
  if (!r.ok) throw new Error('supabase ' + path + ' -> ' + r.status);
  return r.json();
}

async function tdocPut(book, sheet, values) {
  const range = `${sheet}!A2:${colLetter(values[0].length)}${1 + values.length}`;
  const r = await fetch(`https://docs.qq.com/openapi/sheetbook/v2/${book}/values/${range}`, {
    method: 'PUT',
    headers: tdocHeaders,
    body: JSON.stringify({ values }),
  });
  const text = await r.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: r.status, json };
}

const byNewest = (a, b) => new Date(b.submitted_at) - new Date(a.submitted_at);

// ===== 全部活动投稿（keyflow_deliveries）=====
const [deliveries, apps, acts] = await Promise.all([
  sbGet('/rest/v1/keyflow_deliveries?select=id,application_id,submitted_at,article_title,article_url,claimed_word_count,verified_word_count,status&limit=100000'),
  sbGet('/rest/v1/keyflow_applications?select=id,zhihu_name,activity_id&limit=100000'),
  sbGet('/rest/v1/keyflow_activities?select=id,title,game_name&limit=100000'),
]);
const appById = Object.fromEntries(apps.map((a) => [a.id, a]));
const actById = Object.fromEntries(acts.map((a) => [a.id, a]));

const deliveryList = deliveries
  .map((d) => {
    const app = appById[d.application_id] || {};
    const act = actById[app.activity_id] || {};
    return {
      id: d.id,
      submitted_at: d.submitted_at,
      cells: [
        fmt(d.submitted_at),
        app.zhihu_name ?? '',
        act.title || act.game_name || '',
        d.article_title ?? '',
        d.article_url ?? '',
        d.claimed_word_count ?? '',
        d.verified_word_count ?? '',
        DELIVERY_STATUS[d.status] ?? String(d.status ?? ''),
      ],
    };
  })
  .sort(byNewest);

console.log(`deliveries 共 ${deliveryList.length} 条`);
const dWrite = await tdocPut('300000000$XFqoDiFkUgSd', 'BB08J2', deliveryList.map((r) => r.cells));
console.log('写 deliveries:', dWrite.status, JSON.stringify(dWrite.json));

// 重建映射
if (deliveryList.length) {
  const payload = deliveryList.map((r, i) => ({ table_name: 'keyflow_deliveries', record_id: String(r.id), row: 2 + i }));
  const up = await fetch(SUPABASE_URL + '/rest/v1/keyflow_tencent_docs_rows?on_conflict=table_name,record_id', {
    method: 'POST',
    headers: { ...sbHeaders, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates' },
    body: JSON.stringify(payload),
  });
  console.log('重建 deliveries 映射:', up.status);
}

// ===== 答主日常投稿（keyflow_daily_submissions）=====
const [dsubs, answerers] = await Promise.all([
  sbGet('/rest/v1/keyflow_daily_submissions?select=id,answerer_id,submitted_at,article_title,article_url,reviewed&limit=100000'),
  sbGet('/rest/v1/keyflow_answerers?select=id,zhihu_name&limit=100000'),
]);
const answererById = Object.fromEntries(answerers.map((a) => [a.id, a]));

const subList = dsubs
  .map((s) => ({
    id: s.id,
    submitted_at: s.submitted_at,
    cells: [
      fmt(s.submitted_at),
      answererById[s.answerer_id]?.zhihu_name ?? '',
      s.article_title ?? '',
      s.article_url ?? '',
      s.reviewed ? '已审' : '未审',
    ],
  }))
  .sort(byNewest);

console.log(`daily_submissions 共 ${subList.length} 条`);
const sWrite = await tdocPut('300000000$XwFCxmZrIgSH', 'BB08J2', subList.map((r) => r.cells));
console.log('写 daily_submissions:', sWrite.status, JSON.stringify(sWrite.json));

if (subList.length) {
  const payload = subList.map((r, i) => ({ table_name: 'keyflow_daily_submissions', record_id: String(r.id), row: 2 + i }));
  const up = await fetch(SUPABASE_URL + '/rest/v1/keyflow_tencent_docs_rows?on_conflict=table_name,record_id', {
    method: 'POST',
    headers: { ...sbHeaders, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates' },
    body: JSON.stringify(payload),
  });
  console.log('重建 daily_submissions 映射:', up.status);
}

console.log('DONE');
