const CLIENT_ID = '25e9d8cc4ce84cc3a61c9c749e218fb7';
const OPEN_ID = '706cdda513014957ba6f39f694a3b557';
const ACCESS_TOKEN = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJjbHQiOiIyNWU5ZDhjYzRjZTg0Y2MzYTYxYzljNzQ5ZTIxOGZiNyIsInR5cCI6MSwiZXhwIjoxNzg3ODk0Mzk2LjI1NTEwMSwiaWF0IjoxNzg1MzAyMzk2LjI1NTEwMSwic3ViIjoiNzA2Y2RkYTUxMzAxNDk1N2JhNmYzOWY2OTRhM2I1NTcifQ.orwl3IxSHOBrVaIczPKztvwdVDVSALhQoCjG6n3tyJA';

const headers = {
  'Content-Type': 'application/json',
  'Access-Token': ACCESS_TOKEN,
  'Client-Id': CLIENT_ID,
  'Open-Id': OPEN_ID,
};

async function v3(fileId, sheet, range) {
  const r = await fetch(`https://docs.qq.com/openapi/spreadsheet/v3/files/${fileId}/${sheet}/${range}`, { headers });
  const text = await r.text();
  let j; try { j = JSON.parse(text); } catch { j = text; }
  const rows = (j?.gridData?.rows || []).map((r) => (r?.values || []).map((c) => c?.cellValue?.text ?? ''));
  return { status: r.status, rows, raw: text.slice(0, 120) };
}

for (const [label, shortId, book, n] of [
  ['deliveries', 'DWEZxb0RpRmtVZ1Nk', '300000000$XFqoDiFkUgSd', 4],
  ['daily_submissions', 'DWHdGQ3htWnJJZ1NI', '300000000$XwFCxmZrIgSH', 4],
]) {
  console.log('=== ' + label + ' (shortId) ===');
  const a = await v3(shortId, 'BB08J2', `A1:D${n}`);
  console.log('status', a.status, 'raw', a.raw);
  console.log(JSON.stringify(a.rows, null, 0));
}
