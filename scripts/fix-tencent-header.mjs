const BOOK = '300000000$XQpxEHiSksps';
const CLIENT_ID = '25e9d8cc4ce84cc3a61c9c749e218fb7';
const OPEN_ID = '706cdda513014957ba6f39f694a3b557';
const ACCESS_TOKEN = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJjbHQiOiIyNWU5ZDhjYzRjZTg0Y2MzYTYxYzljNzQ5ZTIxOGZiNyIsInR5cCI6MSwiZXhwIjoxNzg3ODk0Mzk2LjI1NTEwMSwiaWF0IjoxNzg1MzAyMzk2LjI1NTEwMSwic3ViIjoiNzA2Y2RkYTUxMzAxNDk1N2JhNmYzOWY2OTRhM2I1NTcifQ.orwl3IxSHOBrVaIczPKztvwdVDVSALhQoCjG6n3tyJA';

const headers = {
  'Content-Type': 'application/json',
  'Access-Token': ACCESS_TOKEN,
  'Client-Id': CLIENT_ID,
  'Open-Id': OPEN_ID,
};

async function put(url, body) {
  const resp = await fetch(url, { method: 'PUT', headers, body: JSON.stringify(body) });
  const text = await resp.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: resp.status, json };
}

const HEADER = ['创建时间', '标题', '知乎链接', '状态'];

for (const sheetID of ['BB08J2', '9PKN2L']) {
  const url = `https://docs.qq.com/openapi/sheetbook/v2/${BOOK}/values/${sheetID}!A1:D1`;
  const r = await put(url, { values: [HEADER] });
  console.log(`=== PUT header ${sheetID} ===`);
  console.log('status', r.status);
  console.log(JSON.stringify(r.json));
}
