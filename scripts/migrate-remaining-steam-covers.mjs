import { execFileSync } from 'node:child_process';
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
const key = resolve(root, '..', 'OpenClaw.pem');
const host = 'root@39.96.61.144';

const { data, error } = await supabase
  .from('keyflow_activities')
  .select('id, game_cover')
  .or('game_cover.like.%steamstatic.com%,game_cover.like.%steamcdn%');
if (error) throw error;

let done = 0;
const failed = [];
for (const item of data) {
  const filename = `steam-fallback-${item.id}.jpg`;
  const remotePath = `/www/wwwroot/39.96.61.144/media/game-covers/${filename}`;
  try {
    execFileSync('ssh', [
      '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', '-i', key, host,
      `curl -fsSL --retry 2 --connect-timeout 15 ${JSON.stringify(item.game_cover)} -o ${JSON.stringify(remotePath)} && chmod 644 ${JSON.stringify(remotePath)}`,
    ], { stdio: 'ignore' });
    const url = `https://palewinds.com/media/game-covers/${filename}`;
    const { error: updateError } = await supabase.from('keyflow_activities').update({ game_cover: url }).eq('id', item.id);
    if (updateError) throw updateError;
    console.log(`[${++done}/${data.length}] ${item.id}`);
  } catch (migrationError) {
    failed.push({ id: item.id, error: migrationError.message });
  }
}
console.log(`补充迁移完成：${done} 成功，${failed.length} 失败`);
if (failed.length) console.log(JSON.stringify(failed));