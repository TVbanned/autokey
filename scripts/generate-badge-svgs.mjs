import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
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

function buildIpUserMessage(info) {
  const desc = (info.description || '').trim().slice(0, 400);
  const text = `游戏名称：${info.game_name}\n游戏介绍：${desc || '（无）'}\n请把这款游戏拟人化成一个可爱的 IP 小角色，按 IP-as-Logo 风格生成 SVG。`;
  const content = [{ type: 'text', text }];
  const images = [info.iconDataUrl, info.coverDataUrl, ...(info.screenshotDataUrls || [])].filter(Boolean);
  for (const url of images) {
    content.push({ type: 'image_url', image_url: { url } });
  }
  return content;
}

const IP_STYLE_PROMPT = `你是一名顶级 IP 角色设计师，遵循「IP as Logo」风格。我会给你一款游戏的图标/Logo、封面图（可能还有截图）和文字介绍。请把这款游戏拟人化成一个极其简洁、可爱、萌系的小 IP 角色（可以是角色、动物、机器人、幽灵、植物或物件拟人），用纯 SVG 矢量呈现。

严格约束（必须全部遵守）：
1. 只输出 SVG 代码本身，不要任何解释、不要 markdown 代码块围栏、不要前后缀文字。
2. SVG 自包含：根元素为 <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">；内部禁止使用 <image>、外部字体或任何外部资源。
3. 角色必须极简：用 4-7 个大型基本几何图形（圆角矩形、圆、椭圆、圆角路径）拼成一个连续的圆润外轮廓，只保留最多 1 个识别性特征（如头顶建筑帽、一对圆角角、一个大圆镜片、一撮呆毛等）。删除一切不承载身份/表情/辨识度的形状。
4. 表情只允许：两只简单圆眼睛；仅在需要时加一个极小的嘴巴。禁止眉毛、高光、睫毛、鼻孔、纹理、描边和装饰性细节。
5. 配色严格 3 色：2 个角色主色 + 1 个纯色背景。2 个角色色取自游戏 icon/封面/介绍的主色调，组织成大色块；表情复用角色色。背景为单一纯色（略降饱和、干净有意图），背景必须纯色填充，禁止渐变、纹理、晕影、光晕。
6. 禁止出现任何文字、字母、数字、符号。
7. 构图：角色保持直立，从画布左下角或右下角冒出，占画布约 85-95%，视觉上占据右下/左下角（禁止居中或中下）。底部或所在侧可被裁切。所有轮廓圆润厚重，禁止尖锐角、尖耳、尖喙、细天线、细嘴、窄缝隙。
8. 可爱萌系是核心：大头、短小身体、紧凑比例、圆润形体、温和友好的表情，在 32×32 下依然清晰可辨。
9. 角色身份必须贴合游戏：从游戏 icon/Logo/封面/介绍中提炼最具代表性的视觉母题（角色、物件、场景符号），把游戏"灵魂"压缩成这个小角色，让人一眼联想到这款游戏。`;

const ROUND_STYLE_PROMPT = `你是一名顶级游戏徽章设计师。我会给你一款游戏的图标/Logo、封面图（可能还有截图）和文字介绍。请先锁定这款游戏最不可替代的视觉母题——具体角色、标志性物件、世界/玩法的核心象征、场景地标或徽记——然后把它压缩为一个一眼能读懂的圆形游戏徽章 SVG。

严格约束（必须全部遵守）：
1. 只输出 SVG 代码本身，不要任何解释、不要 markdown 代码块围栏、不要前后缀文字。
2. SVG 自包含：根元素必须为 <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">；内部禁止使用 <image>、外部字体或任何外部资源。
3. 徽章必须是居中的正圆形徽章：使用圆形外边缘/圆形底板（建议中心 256,256，半径约 225），画布四角必须透明或空白，绝不能用方形背景填满画布。可添加简洁的圆形内环，但不要方框、卡片、盾牌或边角装饰。
4. 圆形内主体必须与游戏强绑定：不要泛用小人、表情脸、无意义的抽象几何。优先把游戏最具辨识度的「具体物件或场景」做成主角，例如城市游戏用道路网络与天际线、修仙游戏用宗门山门/飞剑/太极意象、农场游戏用对应作物与小镇设施、科幻游戏用该作最代表性的机械/空间意象、武侠游戏用刀剑与江湖地标。主体必须占圆内约 65-80%，在 32×32 下可识别。
5. 允许人物、动物、机器人或拟人化物件，但仅当它确实是游戏最强识别符号；不要为了可爱而强行做成小人。若有角色，角色也必须携带足够明确的游戏专属物件/轮廓。
6. 风格：现代扁平矢量徽章，使用 3-5 种取自游戏 icon/封面/截图的主导色；可用轻微渐变制造层次，但禁止写实、复杂纹理、深重阴影、玻璃/金属高光或装饰性噪声。形状清晰、大色块优先。
7. 禁止出现任何文字、字母、数字、Logo 原文、UI 图标或水印。
8. 构图必须以圆形轮廓为边界，主体居中且平衡，留出至少 10% 的圆形内边距；视觉元素可自然与圆边相接，但不得超出圆形轮廓。`;

function buildRoundUserMessage(info) {
  const desc = (info.description || '').trim().slice(0, 400);
  const text = `游戏名称：${info.game_name}\n游戏介绍：${desc || '（无）'}\n请结合图标/Logo、封面和截图，选择一个最有辨识度且与游戏强绑定的具体视觉母题，生成圆形游戏徽章 SVG。不要把它泛化成普通小人或表情角色。`;
  const content = [{ type: 'text', text }];
  const images = [info.iconDataUrl, info.coverDataUrl, ...(info.screenshotDataUrls || [])].filter(Boolean);
  for (const url of images) {
    content.push({ type: 'image_url', image_url: { url } });
  }
  return content;
}

const ROUND_UNIFIED_STYLE_PROMPT = `你是一名顶级游戏徽章设计师。我会给你一款游戏的图标/Logo、封面图（可能还有截图）和文字介绍。请找出这款游戏最不可替代的具体视觉母题（角色、物件、玩法象征、场景地标或徽记），并在一套严格统一的圆形扁平徽章系统内呈现它。

严格约束（必须全部遵守）：
1. 只输出 SVG 代码本身，不要解释、不要 markdown 代码块围栏、不要前后缀文字。
2. SVG 自包含：根元素必须为 <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">；禁止 <image>、外部字体或外部资源。
3. 统一的徽章结构不可改变：画布四角透明/空白；先画一个居中的深墨蓝外圆盘 <circle cx="256" cy="256" r="232" fill="#171B24"/>，再画一个居中的游戏色内圆盘 <circle cx="256" cy="256" r="210" fill="..."/>。禁止额外圆环、描边、边框、投影、卡片、方形背景或不规则外轮廓。
4. 所有视觉元素必须裁切在内圆盘之内：在 <defs> 中建立 id="badgeClip" 的圆形 clipPath（cx=256, cy=256, r=210），并把所有游戏主体放进 <g clip-path="url(#badgeClip)">。主体与圆边至少保持约 22px 空隙。
5. 使用严格扁平纯色：整个 SVG 禁止 stroke、linearGradient、radialGradient、filter、opacity、mask、阴影、高光、纹理、噪点与任何半透明效果。仅使用 fill 纯色的大色块。
6. 全图最多 4 个颜色：固定外圆盘 #171B24；内圆盘用一个来自游戏视觉的中低饱和主色；游戏主体只使用另外 2 个高对比纯色。不要使用黑色描边替代颜色分区。
7. 圆内主体必须强绑定游戏，不要泛用小人、笑脸或无意义图形。用 3-6 个大而清晰的形状压缩该游戏独有的物件/场景/玩法象征；城市是道路网络和天际线，宗门是飞剑与山门，农场是作物与设施，科幻是专属机械/空间意象，武侠是兵器与江湖地标。主体约占内圆 65-75%，在 32×32 下可识别。
8. 禁止出现文字、字母、数字、游戏 Logo 原文、UI 图标、水印。不要绘制人物，除非人物本身就是该游戏最具辨识度的唯一符号。`;

function buildRoundUnifiedUserMessage(info) {
  const desc = (info.description || '').trim().slice(0, 400);
  const text = `游戏名称：${info.game_name}\n游戏介绍：${desc || '（无）'}\n请从图标/Logo、封面和截图中选取最独特的具体游戏母题，严格使用统一的双圆盘、无描边、无渐变、纯色扁平系统生成圆形徽章 SVG。不要做泛用角色。`;
  const content = [{ type: 'text', text }];
  const images = [info.iconDataUrl, info.coverDataUrl, ...(info.screenshotDataUrls || [])].filter(Boolean);
  for (const url of images) {
    content.push({ type: 'image_url', image_url: { url } });
  }
  return content;
}

function selectPrompt(info) {
  if (info.style === 'ip') return IP_STYLE_PROMPT;
  if (info.style === 'round') return ROUND_STYLE_PROMPT;
  if (info.style === 'round-unified') return ROUND_UNIFIED_STYLE_PROMPT;
  return SYSTEM_PROMPT;
}

function selectUserMessage(info) {
  if (info.style === 'ip') return buildIpUserMessage(info);
  if (info.style === 'round') return buildRoundUserMessage(info);
  if (info.style === 'round-unified') return buildRoundUnifiedUserMessage(info);
  return buildUserMessage(info);
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
          { role: 'system', content: selectPrompt(info) },
          { role: 'user', content: selectUserMessage(info) },
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

async function generateSvgWithRetry(info, retries = 5) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      return await generateSvg(info);
    } catch (e) {
      lastErr = e;
      const overload = /429|overload/i.test(e.message);
      const wait = overload ? 15000 : 3000;
      console.log(`  [重试 ${i + 1}/${retries}] ${info.game_name}: ${e.message}（${wait / 1000}s 后重试）`);
      await new Promise((r) => setTimeout(r, wait));
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
  const style = process.argv[5] || 'abstract'; // abstract | ip | round | round-unified

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

  // sample 模式下跳过已生成的样张（便于断点续跑）
  const suffix = style === 'ip' ? '-ip' : style === 'round' ? '-round' : style === 'round-unified' ? '-round-unified' : '';
  const previewDir = resolve(root, 'scripts', 'preview');
  mkdirSync(previewDir, { recursive: true });

  const pending = [];
  for (const t of targets) {
    if (mode === 'sample' && existsSync(resolve(previewDir, `${t.id}${suffix}.svg`))) continue;
    pending.push(t);
  }
  const skipped = targets.length - pending.length;
  if (skipped) console.log(`跳过已存在样张 ${skipped} 个`);
  const targets_ = pending;

  const infos = targets_.map((b) => {
    const act = actByGame.get(b.game_name) || { cover: '', description: '' };
    return { id: b.id, game_name: b.game_name, style, ...act };
  });

  const withCover = infos.filter((i) => i.cover).length;
  console.log(
    `共 ${badges.length} 个徽章，本次处理 ${infos.length} 个（模式 ${mode}，并发 ${concurrency}，其中 ${withCover} 个有封面图）`
  );

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
      writeFileSync(resolve(previewDir, `${info.id}${suffix}.svg`), svg, 'utf8');
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
