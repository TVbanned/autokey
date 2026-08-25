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

function card(svg, name) {
  return `<div class="card"><div class="badge">${svg}</div><div class="name">${name}</div></div>`;
}

const sections = [];
const abstractCards = [];
const ipCards = [];
const roundCards = [];
const unifiedRoundCards = [];
const enamelRoundCards = [];
const pureEnamelRoundCards = [];
for (const b of badges) {
  const plain = files.find((f) => f === `${b.id}.svg`);
  const ip = files.find((f) => f === `${b.id}-ip.svg`);
  const round = files.find((f) => f === `${b.id}-round.svg`);
  const unifiedRound = files.find((f) => f === `${b.id}-round-unified.svg`);
  const enamelRound = files.find((f) => f === `${b.id}-round-enamel.svg`);
  const pureEnamelRound = files.find((f) => f === `${b.id}-round-enamel-pure.svg`);
  if (plain) abstractCards.push(card(readFileSync(resolve(previewDir, plain), 'utf8'), b.game_name));
  if (ip) ipCards.push(card(readFileSync(resolve(previewDir, ip), 'utf8'), b.game_name));
  if (round) roundCards.push(card(readFileSync(resolve(previewDir, round), 'utf8'), b.game_name));
  if (unifiedRound) unifiedRoundCards.push(card(readFileSync(resolve(previewDir, unifiedRound), 'utf8'), b.game_name));
  if (enamelRound) enamelRoundCards.push(card(readFileSync(resolve(previewDir, enamelRound), 'utf8'), b.game_name));
  if (pureEnamelRound) pureEnamelRoundCards.push(card(readFileSync(resolve(previewDir, pureEnamelRound), 'utf8'), b.game_name));
}
if (abstractCards.length) sections.push(section('抽象 · 3D 质感', abstractCards));
if (ipCards.length) sections.push(section('IP as Logo · 可爱角色', ipCards));
if (roundCards.length) sections.push(section('圆形 · 游戏主题徽章', roundCards));
if (unifiedRoundCards.length) sections.push(section('圆形 · 统一视觉系统', unifiedRoundCards));
if (enamelRoundCards.length) sections.push(section('圆形 · 珐琅金属徽章', enamelRoundCards));
if (pureEnamelRoundCards.length) sections.push(section('圆形 · 纯净珐琅金属徽章', pureEnamelRoundCards));

function section(title, cards) {
  return `<h2>${title}</h2><div class="grid">${cards.join('\n')}</div>`;
}

const html = `<!doctype html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>徽章样张预览（Kimi K3 · SVG 矢量）</title><style>
body{margin:0;background:#0d0f14;color:#e8eaf0;font-family:-apple-system,Segoe UI,Roboto,sans-serif;padding:32px}
h1{font-size:20px;font-weight:600;margin:0 0 4px}
p.sub{color:#9aa1b0;margin:0 0 8px;font-size:14px}
h2{font-size:16px;font-weight:600;margin:28px 0 14px;color:#cdd3dd}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:24px}
.card{background:#161a22;border-radius:16px;padding:16px;display:flex;flex-direction:column;align-items:center;gap:12px}
.badge{width:100%;aspect-ratio:1}
.badge svg{width:100%;height:100%;display:block;border-radius:12px}
.name{font-size:14px;color:#cdd3dd;text-align:center}
</style></head><body><h1>徽章样张预览（Kimi K3 · SVG 矢量）</h1><p class="sub">两种风格并行对比</p>${sections.join('\n')}</body></html>`;

writeFileSync(resolve(previewDir, 'preview.html'), html, 'utf8');
console.log('已生成', resolve(previewDir, 'preview.html'));
