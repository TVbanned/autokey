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
const endpoint = 'https://palewinds.com/steam-cover.php';
const concurrency = 2;

function appId(url) {
  try { return new URL(url).pathname.match(/^\/app\/(\d+)(?:\/|$)/)?.[1] || null } catch { return null }
}

const { data, error } = await supabase.from('keyflow_activities').select('id, steam_url').not('steam_url', 'is', null);
if (error) throw error;
const queue = data.filter((item) => appId(item.steam_url));
const failed = [];
let done = 0;

async function worker() {
  while (queue.length) {
    const item = queue.shift();
    try {
      const details = await supabase.functions.invoke('steam-appdetails', { body: { appId: appId(item.steam_url) } });
      if (details.error || !details.data?.success) throw new Error(details.data?.error || details.error?.message || 'Steam 元数据抓取失败');
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ appId: appId(item.steam_url), sourceUrl: details.data.game?.cover || '' }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || !result.url) throw new Error(result.error || String(response.status));
      const { error: updateError } = await supabase.from('keyflow_activities').update({ game_cover: result.url }).eq('id', item.id);
      if (updateError) throw updateError;
      console.log(`[${++done}/${data.length}] ${item.id}`);
    } catch (refreshError) {
      failed.push({ id: item.id, appId: appId(item.steam_url), error: refreshError.message });
    }
  }
}
await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));
console.log(`刷新完成：${done} 成功，${failed.length} 失败`);
if (failed.length) console.log(JSON.stringify(failed));