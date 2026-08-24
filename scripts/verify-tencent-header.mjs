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

async function get(url) {
  const resp = await fetch(url, { headers });
  const text = await resp.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text; }
  return json;
}

for (const sheetID of ['BB08J2', '9PKN2L']) {
  const url = `https://docs.qq.com/openapi/spreadsheet/v3/files/${BOOK}/${sheetID}/A1:D1`;
  const j = await get(url);
  const texts = j?.gridData?.rows?.[0]?.values?.map((c) => c?.cellValue?.text ?? '');
  console.log(`${sheetID} header:`, JSON.stringify(texts));
}
