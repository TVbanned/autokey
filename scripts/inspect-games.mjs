import { readFileSync } from 'node:fs';
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

const { data, error } = await supabase
  .from('keyflow_activities')
  .select('game_name, game_cover, game_screenshots, steam_url, description')
  .neq('game_cover', '')
  .limit(8);
if (error) throw error;

for (const a of data) {
  console.log('\n===', a.game_name, '===');
  console.log('cover:', a.game_cover);
  console.log('steam_url:', a.steam_url);
  console.log('screenshots:', a.game_screenshots);
  console.log('desc:', (a.description || '').slice(0, 120));
}
