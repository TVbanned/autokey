import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

function loadEnv() {
  const raw = readFileSync(resolve(root, '.env'), 'utf8');
  const env = {};
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return env;
}

const env = loadEnv();
const MOONSHOT_API_KEY = env.MOONSHOT_API_KEY;
const MOONSHOT_BASE_URL = env.MOONSHOT_BASE_URL || 'https://api.moonshot.cn/v1';
const SUPABASE_URL = env.VITE_SUPABASE_URL;
const SUPABASE_SERVICE_KEY = env.SUPABASE_SERVICE_KEY;
const MODEL = 'kimi-k3';

const SYSTEM_PROMPT = `你是一名顶级图形/徽章设计师。我会给你一款游戏的图标/Logo、封面图（可能还有截图）和文字介绍。请先提炼该游戏的视觉基因——Logo 的核心图形符号、主色调、标志性元素、美术氛围——然后用抽象、极简、高级的 3D 质感 SVG 徽章重新演绎。

严格约束（必须全部遵守）：
1. 只输出 SVG 代码本身，不要任何解释、不要 markdown 代码块围栏、不要前后缀文字。
2. SVG 必须自包含：根元素为 <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">；内部禁止使用 <image>、外部字体或任何外部资源。
3. 风格：抽象几何、极简、高级；用线性/径向渐变 + 柔和高光 + 高斯模糊阴影（feGaussianBlur/filter）营造立体 3D 质感；材质偏低饱和金属/玻璃/磨砂；深色渐变背景。
4. 禁止出现任何文字、字母、数字、符号。
5. 主体居中、构图均衡、留白充足，视觉元素不要贴边（四周至少留 8% 边距）。
6. 配色克制（2-4 种），并取自图标/封面/截图的主导色相。
7. 优先从游戏图标/Logo 中提取标志性符号或图形轮廓（独特的剪影、徽记、几何母题），将其抽象成简约几何图形（而非复刻画作或文字），让人一眼联想到该游戏；若 Logo 以文字为主，则提取其背后最标志性的图形元素（角色、物件、场景母题）。`;

function buildUserMessage(info) {
  const desc = (info.description || '').trim().slice(0, 400);
  const text = `游戏名称：${info.game_name}\n游戏介绍：${desc || '（无）'}\n请结合上面给出的游戏图标/Logo 与封面图，提炼核心视觉符号，生成抽象 3D 质感徽章 SVG。`;
  const content = [{ type: 'text', text }];
  const images = [info.iconDataUrl, info.coverDataUrl, ...(info.screenshotDataUrls || [])].filter(Boolean);
  for (const url of images) {
    content.push({ type: 'image_url', image_url: { url } });
  }
  return content;
}

async function fetchImageDataUrl(url) {
  const res = await fetch(url, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
      Referer: 'https://store.steampowered.com/',
    },
  });
  if (!res.ok) throw new Error(`图片下载失败 ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const mime = res.headers.get('content-type') || 'image/jpeg';
  return `data:${mime};base64,${buf.toString('base64')}`;
}

function extractAppId(steamUrl) {
  const m = (steamUrl || '').match(/\/app\/(\d+)/);
  return m ? m[1] : null;
}

function normalizeScreenshots(v) {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string' && v.trim()) {
    try { return JSON.parse(v); } catch { return []; }
  }
  return [];
}

async function fetchSteamAssets(steamUrl) {
  const appId = extractAppId(steamUrl);
  if (!appId) return null;
  const res = await fetch(
    `https://store.steampowered.com/api/appdetails?appids=${appId}&l=schinese&cc=cn`,
    { headers: { 'User-Agent': 'keyflow/1.0' } },
  );
  if (!res.ok) return null;
  const json = await res.json();
  const game = json?.[appId]?.data;
  if (!json?.[appId]?.success || !game) return null;
  return {
    cover: game.header_image || '',
    icon: game.capsule_image || '',
    screenshots: (game.screenshots || [])
      .map((s) => (s.path_full || s.path_thumbnail || '').replace(/\.1920x1080\.jpg/, '.600x338.jpg'))
      .filter(Boolean)
      .slice(0, 2),
  };
}

async function generateSvg(info) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 180000);
  try {
    const res = await fetch(`${MOONSHOT_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${MOONSHOT_API_KEY}`,
      },
      body: JSON.stringify({
        model: MODEL,
        reasoning_effort: 'low',
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: buildUserMessage(info) },
        ],
        max_tokens: 8192,
      }),
      signal: ctrl.signal,
    });
    const json = await res.json();
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${JSON.stringify(json).slice(0, 400)}`);
    }
    const text = json.choices?.[0]?.message?.content ?? '';
    const m = text.match(/<svg[\s\S]*?<\/svg>/i);
    if (!m) {
      throw new Error(`未解析到 SVG，原始返回：${text.slice(0, 200)}`);
    }
    return m[0];
  } finally {
    clearTimeout(timer);
  }
}

async function generateSvgWithRetry(info, retries = 2) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      return await generateSvg(info);
    } catch (e) {
      lastErr = e;
      console.log(`  [重试 ${i + 1}/${retries}] ${info.game_name}: ${e.message}`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  throw lastErr;
}

async function runPool(items, limit, worker) {
  const queue = [...items];
  const results = [];
  const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length) {
      const item = queue.shift();
      try {
        results.push({ item, ok: true, value: await worker(item) });
      } catch (e) {
        results.push({ item, ok: false, error: e });
      }
    }
  });
  await Promise.all(workers);
  return results;
}

async function main() {
  const mode = process.argv[2] || 'sample'; // sample | full
  const sampleCount = Number(process.argv[3] || 4);
  const concurrency = Number(process.argv[4] || 4);

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

  // 活动表（含封面/截图/介绍/Steam地址）按 game_name 建索引
  const { data: activities, error: actErr } = await supabase
    .from('keyflow_activities')
    .select('game_name, game_cover, game_screenshots, steam_url, description')
    .neq('game_cover', '');
  if (actErr) throw actErr;

  const actByGame = new Map();
  for (const a of activities) {
    if (!actByGame.has(a.game_name)) {
      actByGame.set(a.game_name, {
        cover: a.game_cover || '',
        steam_url: a.steam_url || '',
        screenshots: a.game_screenshots || '',
        description: a.description || '',
      });
    }
  }

  const { data: badges, error } = await supabase
    .from('keyflow_badges')
    .select('id, game_name')
    .order('id');
  if (error) throw error;

  const targets =
    mode === 'full' ? badges : badges.slice(0, sampleCount);

  const infos = targets.map((b) => {
    const act = actByGame.get(b.game_name) || { cover: '', description: '' };
    return { id: b.id, game_name: b.game_name, ...act };
  });

  const withCover = infos.filter((i) => i.cover).length;
  console.log(
    `共 ${badges.length} 个徽章，本次处理 ${infos.length} 个（模式 ${mode}，并发 ${concurrency}，其中 ${withCover} 个有封面图）`
  );

  const previewDir = resolve(root, 'scripts', 'preview');
  mkdirSync(previewDir, { recursive: true });

  let done = 0;
  const results = await runPool(infos, concurrency, async (info) => {
    if (info.steam_url) {
      try {
        const assets = await fetchSteamAssets(info.steam_url);
        if (assets) {
          if (assets.cover) info.cover = assets.cover;
          if (assets.icon) info.icon = assets.icon;
          if (assets.screenshots?.length) info.screenshots = assets.screenshots;
        }
      } catch (e) {
        console.log(`  [无Steam资产] ${info.game_name}: ${e.message}`);
      }
    }
    if (info.cover) {
      try {
        info.coverDataUrl = await fetchImageDataUrl(info.cover);
      } catch (e) {
        console.log(`  [无封面] ${info.game_name}: ${e.message}`);
      }
    }
    if (info.icon) {
      try {
        info.iconDataUrl = await fetchImageDataUrl(info.icon);
      } catch (e) {
        console.log(`  [无图标] ${info.game_name}: ${e.message}`);
      }
    }
    info.screenshotDataUrls = [];
    for (const s of normalizeScreenshots(info.screenshots).slice(0, 2)) {
      try {
        info.screenshotDataUrls.push(await fetchImageDataUrl(s));
      } catch (e) {
        // 截图下载失败可忽略
      }
    }
    const svg = await generateSvgWithRetry(info);
    if (mode === 'full') {
      const blob = new Blob([svg], { type: 'image/svg+xml' });
      const { error: upErr } = await supabase.storage
        .from('badges')
        .upload(`${info.id}.svg`, blob, { contentType: 'image/svg+xml', upsert: true });
      if (upErr) throw upErr;
      const { data: pub } = supabase.storage.from('badges').getPublicUrl(`${info.id}.svg`);
      const { error: dbErr } = await supabase
        .from('keyflow_badges')
        .update({ image_url: pub.publicUrl })
        .eq('id', info.id);
      if (dbErr) throw dbErr;
    } else {
      writeFileSync(resolve(previewDir, `${info.id}.svg`), svg, 'utf8');
    }
    done++;
    console.log(`  [${done}/${infos.length}] OK ${info.game_name}`);
    return svg;
  });

  const ok = results.filter((r) => r.ok).length;
  const fail = results.filter((r) => !r.ok);
  console.log(`\n完成：成功 ${ok}，失败 ${fail.length}`);
  for (const f of fail) {
    console.log(`  失败 ${f.item.game_name}: ${f.error?.message}`);
  }
  if (fail.length) process.exit(1);
}

main().catch((e) => {
  console.error('失败：', e);
  process.exit(1);
});
