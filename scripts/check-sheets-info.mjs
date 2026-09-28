const CLIENT_ID = '25e9d8cc4ce84cc3a61c9c749e218fb7';
const OPEN_ID = '706cdda513014957ba6f39f694a3b557';
const ACCESS_TOKEN = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJjbHQiOiIyNWU5ZDhjYzRjZTg0Y2MzYTYxYzljNzQ5ZTIxOGZiNyIsInR5cCI6MSwiZXhwIjoxNzkzMTUwMDgwLjY0NDUyMSwiaWF0IjoxNzkwNTU4MDgwLjY0NDUyMSwic3ViIjoiNzA2Y2RkYTUxMzAxNDk1N2JhNmYzOWY2OTRhM2I1NTcifQ.a7sNwhE5ClFLutIoyuzkiw5nMWIdp3hIOG_xDAdatI0';

const headers = {
  'Content-Type': 'application/json',
  'Access-Token': ACCESS_TOKEN,
  'Client-Id': CLIENT_ID,
  'Open-Id': OPEN_ID,
};

const books = [
  '300000000$XQpxEHiSksps',
  '300000000$XFqoDiFkUgSd',
  '300000000$XwFCxmZrIgSH',
];

for (const b of books) {
  const r = await fetch(`https://docs.qq.com/openapi/sheetbook/v2/${b}/sheets-info`, { headers });
  const text = await r.text();
  console.log('=== ' + b + ' ===');
  console.log('status', r.status);
  console.log(text.slice(0, 500));
}
