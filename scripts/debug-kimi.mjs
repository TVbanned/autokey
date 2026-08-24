import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const envRaw = readFileSync(resolve(root, '.env'), 'utf8');
const env = {};
for (const line of envRaw.split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

const res = await fetch(`${env.MOONSHOT_BASE_URL}/chat/completions`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${env.MOONSHOT_API_KEY}`,
  },
  body: JSON.stringify({
    model: 'kimi-k3',
    messages: [
      { role: 'user', content: '只输出一个最小可用的红色圆形 SVG，不要任何解释。' },
    ],
    max_tokens: 2048,
  }),
});

const json = await res.json();
console.log('HTTP', res.status);
if (json.error) console.log('ERROR', JSON.stringify(json.error));
const msg = json.choices?.[0]?.message;
console.log('message keys:', msg ? Object.keys(msg) : '(none)');
for (const [k, v] of Object.entries(msg || {})) {
  console.log(`\n--- ${k} (len=${typeof v === 'string' ? v.length : '?'}) ---`);
  console.log(typeof v === 'string' ? v.slice(0, 600) : JSON.stringify(v).slice(0, 600));
}
console.log('\nusage:', JSON.stringify(json.usage));
