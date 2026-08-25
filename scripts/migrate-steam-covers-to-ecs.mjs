import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createClient } from '@supabase/supabase-js';

const root = resolve(import.meta.dirname, '..');
const env = {};
for (const line of readFileSync(resolve(root, '.env'), 'utf8').split(/\r?\n/)) {
  const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (match) env[match[1]] = match[2].replace(/^["']|["']$/g, '');
}
const supabase = createClient(env.VITE_SUPABASE_URL, env.SUPABASE_SERVICE_KEY);
const target = 'https://palewinds.com/steam-cover.php';
const concurrency = 1;

function appId(url) {
  try { return new URL(url).pathname.match(/^\/app\/(\d+)(?:\/|$)/)?.[1] || null } catch { return null }
}

const { data, error } = await supabase
  .from('keyflow_activities')
  .select('id, steam_url, game_cover')
  .not('steam_url', 'is', null)
  .or('game_cover.like.%steamstatic.com%,game_cover.like.%steamcdn%');
if (error) throw error;

const queue = data.filter((item) => appId(item.steam_url));
let done = 0;
const failed = [];
async function worker() {
  while (queue.length) {
    const item = queue.shift();
    try {
      const response = await fetch(target, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ appId: appId(item.steam_url) }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || !result.url) throw new Error(result.error || String(response.status));
      const { error: updateError } = await supabase.from('keyflow_activities').update({ game_cover: result.url }).eq('id', item.id);
      if (updateError) throw updateError;
      console.log(`[${++done}/${data.length}] ${item.id}`);
    } catch (error) {
      failed.push({ id: item.id, appId: appId(item.steam_url), error: error.message });
    }
  }
}
await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));
console.log(`Steam 头图迁移完成：${done} 成功，${failed.length} 保留原地址`);
if (failed.length) console.log(JSON.stringify(failed));