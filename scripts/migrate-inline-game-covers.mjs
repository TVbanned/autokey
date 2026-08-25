import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
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
const { data, error } = await supabase.from('keyflow_activities').select('id, game_cover').like('game_cover', 'data:image/%');
if (error) throw error;

for (const item of data) {
  const match = item.game_cover.match(/^data:(image\/(?:jpeg|png|webp));base64,(.+)$/s);
  if (!match) throw new Error(`${item.id}: 无法解析内嵌图片`);
  const ext = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }[match[1]];
  const local = resolve(root, 'scripts', `inline-cover-${item.id}.${ext}`);
  const remote = `/www/wwwroot/39.96.61.144/media/game-covers/manual-${item.id}.${ext}`;
  try {
    writeFileSync(local, Buffer.from(match[2], 'base64'));
    execFileSync('scp', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', '-i', key, local, `${host}:${remote}`], { stdio: 'inherit' });
    execFileSync('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', '-i', key, host, `chown www:www ${JSON.stringify(remote)}; chmod 644 ${JSON.stringify(remote)}`], { stdio: 'inherit' });
    const url = `https://palewinds.com/media/game-covers/manual-${item.id}.${ext}`;
    const { error: updateError } = await supabase.from('keyflow_activities').update({ game_cover: url }).eq('id', item.id);
    if (updateError) throw updateError;
    console.log(`已迁移 ${item.id}`);
  } finally {
    try { unlinkSync(local) } catch {}
  }
}
