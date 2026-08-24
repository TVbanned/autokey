import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const envRaw = readFileSync(resolve(root, '.env'), 'utf8');
const env = {};
for (const line of envRaw.split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

const supabase = createClient(env.VITE_SUPABASE_URL, env.SUPABASE_SERVICE_KEY);
const { data: badges } = await supabase
  .from('keyflow_badges')
  .select('id, game_name')
  .order('id');

const previewDir = resolve(root, 'scripts', 'preview');
const files = readdirSync(previewDir).filter((f) => f.endsWith('.svg'));
const byId = new Map(files.map((f) => [f.replace('.svg', ''), f]));

const cards = badges
  .map((b) => {
    const file = byId.get(b.id);
    if (!file) return null;
    const svg = readFileSync(resolve(previewDir, file), 'utf8');
    return `<div class="card"><div class="badge">${svg}</div><div class="name">${b.game_name}</div></div>`;
  })
  .filter(Boolean)
  .join('\n');

const html = `<!doctype html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>徽章样张预览</title><style>
body{margin:0;background:#0d0f14;color:#e8eaf0;font-family:-apple-system,Segoe UI,Roboto,sans-serif;padding:32px}
h1{font-size:20px;font-weight:600;margin:0 0 4px}
p.sub{color:#9aa1b0;margin:0 0 24px;font-size:14px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:24px}
.card{background:#161a22;border-radius:16px;padding:16px;display:flex;flex-direction:column;align-items:center;gap:12px}
.badge{width:100%;aspect-ratio:1}
.badge svg{width:100%;height:100%;display:block;border-radius:12px}
.name{font-size:14px;color:#cdd3dd;text-align:center}
</style></head><body><h1>徽章样张预览（Kimi K3 · SVG 矢量）</h1><p class="sub">抽象 · 极简 · 3D 质感 · 深色渐变</p><div class="grid">${cards}</div></body></html>`;

writeFileSync(resolve(previewDir, 'preview.html'), html, 'utf8');
console.log('已生成', resolve(previewDir, 'preview.html'));
