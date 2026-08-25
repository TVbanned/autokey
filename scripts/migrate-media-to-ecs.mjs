import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createClient } from '@supabase/supabase-js';

const root = resolve(import.meta.dirname, '..');
const raw = readFileSync(resolve(root, '.env'), 'utf8');
const env = {};
for (const line of raw.split(/\r?\n/)) {
  const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (match) env[match[1]] = match[2].replace(/^["']|["']$/g, '');
}

const supabase = createClient(env.VITE_SUPABASE_URL, env.SUPABASE_SERVICE_KEY);
const key = resolve(root, '..', 'OpenClaw.pem');
const host = 'root@39.96.61.144';
const mediaBase = 'https://palewinds.com/media';
const concurrency = 3;

async function retry(action, attempts = 4) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await action();
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, attempt * 1500));
    }
  }
  throw lastError;
}

function copyToServer(sourceUrl, targetPath) {
  execFileSync('ssh', [
    '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', '-i', key, host,
    `curl -fsSL --retry 2 --connect-timeout 15 ${JSON.stringify(sourceUrl)} -o ${JSON.stringify(targetPath)} && chmod 644 ${JSON.stringify(targetPath)}`,
  ], { stdio: 'ignore' });
}

function extension(url, fallback = 'webp') {
  const found = new URL(url).pathname.match(/\.([a-zA-Z0-9]+)$/);
  return found ? found[1].toLowerCase() : fallback;
}

async function runPool(items, worker) {
  const queue = [...items];
  let done = 0;
  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    while (queue.length) {
      const item = queue.shift();
      await worker(item);
      console.log(`[${++done}/${items.length}] ${item.id}`);
    }
  });
  await Promise.all(workers);
}

async function migrate(table, idField, urlField, directory) {
  const { data, error } = await supabase.from(table).select(`${idField}, ${urlField}`).like(urlField, '%supabase.co/storage/%');
  if (error) throw error;
  console.log(`${directory}: ${data.length} 个待迁移`);
  await runPool(data, async (item) => {
    const ext = extension(item[urlField]);
    const name = `${item[idField]}.${ext}`;
    await retry(() => Promise.resolve(copyToServer(item[urlField], `/www/wwwroot/39.96.61.144/media/${directory}/${name}`)));
    const { error: updateError } = await retry(() => supabase.from(table).update({ [urlField]: `${mediaBase}/${directory}/${name}` }).eq(idField, item[idField]));
    if (updateError) throw updateError;
  });
}

await migrate('keyflow_answerers', 'id', 'avatar_url', 'avatars');
await migrate('keyflow_badges', 'id', 'image_url', 'badges');
await migrate('keyflow_answerers', 'id', 'dashboard_cover_url', 'covers');
console.log('迁移完成');
