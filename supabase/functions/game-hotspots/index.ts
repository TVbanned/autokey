import { serve } from "https://deno.land/std@0.177.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Content-Type": "application/json; charset=utf-8",
};

const searches = [
  { source: "Google 新闻", query: "游戏 新闻 发布 公布 发售 更新" },
  { source: "游民星空", query: "site:gamersky.com/news 游戏 公布 OR 发售 OR 更新 OR 预告" },
  { source: "3DM", query: "site:3dmgame.com/news 游戏 公布 OR 发售 OR 更新 OR 预告" },
  { source: "Steam官方公告", query: "site:steamcommunity.com/games/*/announcements Steam game announcement" },
  { source: "Reddit", query: "site:reddit.com/r/Games 游戏 新闻 公布 OR 发售" },
];

const rssFeeds = [
  { source: "PC Gamer", url: "https://www.pcgamer.com/rss/" },
  { source: "GamesIndustry.biz", url: "https://www.gamesindustry.biz/feed" },
  { source: "Rock Paper Shotgun", url: "https://www.rockpapershotgun.com/feed" },
  { source: "Eurogamer", url: "https://www.eurogamer.net/feed" },
  { source: "VGC", url: "https://www.videogameschronicle.com/feed/" },
  { source: "Game Informer", url: "https://www.gameinformer.com/rss.xml" },
  { source: "机核", url: "https://www.gcores.com/rss" },
];

type HotspotItem = {
  title: string;
  url: string;
  source: string;
  publisher: string;
  summary: string;
  publishedAt: string;
  relevance: boolean;
};

type Translation = { title: string; summary: string };

let cache: { data: unknown; expiresAt: number } | null = null;
const GAME_TERMS = /游戏|玩家|Steam|PS[45+]?|PlayStation|Xbox|Switch|任天堂|DLC|RPG|电竞|电子竞技|手游|主机|米哈游|腾讯游戏|网易游戏|卡普空|育碧|EA|暴雪|索尼互动娱乐|FromSoftware|GTA|英雄联盟|原神|赛博朋克|黑神话|塞尔达|怪物猎人|game|gaming|PlayStation|Xbox|Nintendo|Valve|Riot|Ubisoft|Bethesda|Capcom|Square Enix|EA|Blizzard|Fortnite|Minecraft/i;
const EVENT_TERMS = /宣布|官宣|公布|发布|上线|发售|定档|预告|实机|更新|补丁|扩展|DLC|停售|收购|裁员|关闭|重启|测试|试玩|登陆|加入|确认|曝光|泄露|改版|联动|获奖|销量|突破|announces?|reveals?|launches?|releases?|delayed|delay|acquires?|acquisition|layoffs?|shuts? down|closure|update|patch|expansion|DLC|trailer|date|confirmed|sales|million|beta|early access/i;
const EXCLUDED_TERMS = /直播带货|明星|演员|电视剧|综艺|电影票房|基金|股价|大模型|AI产品|手机发布|电饭煲|博彩|赌场|娱乐电子|真人视讯|在线投注|棋牌|登录体验|美女人设|图赏|壁纸|攻略|配装|社区 ::|Steam 社区 ::|review|hands-on|preview|opinion|interview|feature|guide|best .+ builds?|what are we playing/i;
const TRUSTED_PUBLISHERS = /游民星空|3DM|机核|GCORES|游研社|触乐|IGN|GameSpot|Polygon|Eurogamer|Kotaku|VGC|Game Informer|PlayStation Blog|Xbox Wire|Nintendo|Epic Games|腾讯游戏|网易游戏|TapTap|篝火营地|GamesIndustry.biz|PC Gamer|Rock Paper Shotgun/i;
const SOURCE_HOSTS: Record<string, RegExp> = {
  "游民星空": /(^|\.)gamersky\.com$/i,
  "3DM": /(^|\.)3dmgame\.com$/i,
  "Steam官方公告": /(^|\.)steamcommunity\.com$/i,
  "Reddit": /(^|\.)reddit\.com$/i,
};

const normalizeTitle = (title = "") => title
  .replace(/<!\[CDATA\[|\]\]>/g, "")
  .replace(/&amp;/g, "&")
  .replace(/\s+[-|｜]\s+(游民星空|3DM|Steam Community|Reddit).*$/i, "")
  .replace(/\s+/g, " ")
  .trim();

function ageHours(date = "") {
  const relative = date.match(/(\d+)\s*(minute|min|hour|day|分钟|小时|天)/i);
  if (relative) {
    const unit = relative[2].toLowerCase();
    return /minute|min|分钟/.test(unit) ? Number(relative[1]) / 60 : /hour|小时/.test(unit) ? Number(relative[1]) : Number(relative[1]) * 24;
  }
  const timestamp = Date.parse(date);
  return Number.isFinite(timestamp) ? Math.max(0, (Date.now() - timestamp) / 3_600_000) : 999;
}

function qualityScore(item: HotspotItem) {
  const eventScore = EVENT_TERMS.test(item.title) ? 30 : 0;
  const publisherScore = TRUSTED_PUBLISHERS.test(item.publisher) || item.source === "Steam官方公告" ? 20 : 0;
  const recencyScore = Math.max(0, 50 - ageHours(item.publishedAt) / 2);
  return Math.round(eventScore + publisherScore + recencyScore);
}

function xmlText(value = "") {
  return normalizeTitle(value.replace(/<[^>]+>/g, "").replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code))));
}

function xmlField(item: string, name: string) {
  const match = item.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, "i"));
  return xmlText(match?.[1] || "");
}

function isEventNews(title: string, summary: string) {
  return EVENT_TERMS.test(title) && !EXCLUDED_TERMS.test(`${title} ${summary}`);
}

function buildTags(source: string, title: string, summary: string) {
  const text = `${title} ${summary}`;
  const tags = [/游民星空|3DM|机核|GCORES|游研社|触乐|腾讯游戏|网易游戏|TapTap|篝火营地/.test(source) ? "国内" : "海外"];
  if (/收购|裁员|关闭|停售|acquisition|layoffs?|shuts? down|closure/i.test(text)) tags.push("行业动态");
  else if (/发售|上线|launches?|releases?|early access|date/i.test(text)) tags.push("发售节点");
  else if (/DLC|扩展|更新|补丁|update|patch|expansion/i.test(text)) tags.push("版本更新");
  else if (/预告|实机|公布|宣布|reveals?|announces?|trailer|gameplay/i.test(text)) tags.push("新品公布");
  else if (/测试|试玩|beta|playtest/i.test(text)) tags.push("测试体验");
  if (/PlayStation|PS[45+]?|Xbox|Switch|任天堂|Steam|主机|platform/i.test(text)) tags.push("平台动态");
  if (/销量|获奖|突破|sales|million|award/i.test(text)) tags.push("市场表现");
  return tags.slice(0, 3);
}

function hasChinese(text: string) {
  return /[\u4e00-\u9fff]/.test(text);
}

async function translateItems(items: HotspotItem[]) {
  const targets = items.filter((item) => !hasChinese(item.title));
  const apiKey = Deno.env.get("DEEPSEEK_API_KEY");
  const baseUrl = Deno.env.get("DEEPSEEK_BASE_URL") || "https://api.deepseek.com/v1";
  if (!targets.length || !apiKey) return { items, translatedCount: 0, translationStatus: apiKey ? "no-targets" : "missing-key" };

  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "deepseek-v4-flash",
        temperature: 0.1,
        max_tokens: 3000,
        messages: [
          { role: "system", content: "你是专业游戏新闻编辑。将英文游戏新闻标题和摘要准确翻译成简体中文。保留游戏名、公司名、平台名、DLC、版本号等专有名词；标题简洁，不添加原文没有的信息。只返回 JSON 对象，格式为 {\"translations\":[{\"index\":0,\"title\":\"...\",\"summary\":\"...\"}]}。" },
          { role: "user", content: JSON.stringify(targets.map((item, index) => ({ index, title: item.title, summary: item.summary.slice(0, 250) }))) },
        ],
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`DeepSeek translation failed (${response.status})`);
    const payload = await response.json();
    const content = String(payload.choices?.[0]?.message?.content || "{}").replace(/^```(?:json)?\s*|\s*```$/g, "");
    const parsed = JSON.parse(content) as { translations?: Array<{ index?: number; title?: string; summary?: string }> };
    const translations = parsed.translations;
    if (!Array.isArray(translations)) return { items, translatedCount: 0, translationStatus: "invalid-response" };
    let translatedCount = 0;
    for (const translation of translations) {
      const target = Number.isInteger(translation.index) ? targets[translation.index as number] : undefined;
      if (!target || !translation.title || !hasChinese(translation.title)) continue;
      target.title = normalizeTitle(translation.title);
      if (translation.summary) target.summary = translation.summary.trim();
      translatedCount += 1;
    }
    return { items, translatedCount, translationStatus: "ok" };
  } catch (error) {
    console.error("game-hotspots DeepSeek translation failed", error);
    return { items, translatedCount: 0, translationStatus: "failed" };
  }
}

async function searchSource(entry: typeof searches[number], apiKey: string): Promise<HotspotItem[]> {
  const response = await fetch("https://google.serper.dev/news", {
    method: "POST",
    headers: { "X-API-KEY": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({ q: entry.query, gl: "cn", hl: "zh-cn", tbs: "qdr:d", num: 15 }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`${entry.source} search failed (${response.status})`);
  const payload = await response.json();
  return (payload.news || []).map((item: { title?: string; link?: string; snippet?: string; date?: string; source?: string }) => {
    const title = normalizeTitle(item.title);
    const url = item.link || "";
    const publisher = item.source || entry.source;
    const summary = item.snippet?.trim() || `${publisher} 的近期游戏新闻。`;
    const parsedUrl = new URL(url || "https://invalid.example");
    const sourceMatches = entry.source === "Google 新闻" || SOURCE_HOSTS[entry.source]?.test(parsedUrl.hostname);
    const officialSteamAnnouncement = entry.source !== "Steam官方公告" || /\/announcements\/?|\/event\//i.test(parsedUrl.pathname);
    const trusted = entry.source !== "Google 新闻" || TRUSTED_PUBLISHERS.test(publisher);
    return {
      title, url, source: entry.source === "Google 新闻" ? publisher : entry.source, publisher, summary,
      publishedAt: item.date || "", tags: buildTags(entry.source === "Google 新闻" ? publisher : entry.source, title, summary),
      relevance: ageHours(item.date || "") <= 72 && GAME_TERMS.test(title) && isEventNews(title, summary) && sourceMatches && officialSteamAnnouncement && trusted,
    };
  }).filter((item: HotspotItem) => item.relevance && item.title.length >= 8 && item.url.startsWith("http"));
}

async function fetchRssFeed(feed: typeof rssFeeds[number]): Promise<HotspotItem[]> {
  const response = await fetch(feed.url, { headers: { "User-Agent": "Mozilla/5.0 GameHotspots/1.0" }, signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`${feed.source} RSS failed (${response.status})`);
  const xml = await response.text();
  const entries = xml.match(/<(?:item|entry)(?:\s[^>]*)?>[\s\S]*?<\/(?:item|entry)>/gi) || [];
  return entries.slice(0, 20).map((entry) => {
    const title = xmlField(entry, "title");
    const link = entry.match(/<link[^>]*href=["']([^"']+)["']/i)?.[1] || xmlField(entry, "link");
    const summary = xmlField(entry, "description") || xmlField(entry, "summary") || xmlField(entry, "content");
    const publishedAt = xmlField(entry, "pubDate") || xmlField(entry, "published") || xmlField(entry, "updated");
    return { title, url: link.replace(/&amp;/g, "&"), source: feed.source, publisher: feed.source, summary, publishedAt, tags: buildTags(feed.source, title, summary), relevance: ageHours(publishedAt) <= 7 * 24 && isEventNews(title, summary) };
  }).filter((item) => item.relevance && item.title.length >= 8 && item.url.startsWith("http"));
}

function titleTokens(title: string) {
  const normalized = title.toLowerCase()
    .replace(/ps\s*\+/g, "psplus")
    .replace(/playstation\s*plus/g, "psplus")
    .replace(/九月/g, "9月")
    .replace(/\bseptember\b/g, "9")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/(宣布|公布|发布|发售|更新|游戏|game|gaming|news|official|the|a|an|and|for|with|to|of)/gi, " ");
  const words = normalized.split(/\s+/).filter((word) => word.length >= 2);
  const chinese = normalized.replace(/[^\u4e00-\u9fff]/g, "");
  for (let index = 0; index < chinese.length - 1; index += 1) words.push(chinese.slice(index, index + 2));
  return new Set(words);
}

function isDuplicateEvent(left: HotspotItem, right: HotspotItem) {
  const leftTokens = titleTokens(left.title);
  const rightTokens = titleTokens(right.title);
  const shared = [...leftTokens].filter((token) => rightTokens.has(token)).length;
  const total = new Set([...leftTokens, ...rightTokens]).size;
  return (shared >= 3 && shared / total >= 0.42) || (shared >= 4 && shared / total >= 0.25);
}

function isPreferred(candidate: HotspotItem, current: HotspotItem) {
  const candidateOfficial = candidate.source === "Steam官方公告" ? 1 : 0;
  const currentOfficial = current.source === "Steam官方公告" ? 1 : 0;
  if (candidateOfficial !== currentOfficial) return candidateOfficial > currentOfficial;
  return qualityScore(candidate) > qualityScore(current);
}

function deduplicateEvents(items: HotspotItem[]) {
  const unique: HotspotItem[] = [];
  for (const item of [...items].sort((a, b) => qualityScore(b) - qualityScore(a))) {
    const duplicateIndex = unique.findIndex((saved) => isDuplicateEvent(item, saved));
    if (duplicateIndex === -1) unique.push(item);
    else if (isPreferred(item, unique[duplicateIndex])) unique[duplicateIndex] = item;
  }
  return unique;
}

function diversify(items: HotspotItem[]) {
  const sorted = [...items].sort((a, b) => qualityScore(b) - qualityScore(a));
  const sourceCounts = new Map<string, number>();
  const result: HotspotItem[] = [];
  const deferred: HotspotItem[] = [];
  for (const item of sorted) {
    const count = sourceCounts.get(item.source) || 0;
    if (count >= 2) deferred.push(item);
    else {
      sourceCounts.set(item.source, count + 1);
      result.push(item);
    }
    if (result.length === 20) return result;
  }
  for (const item of deferred) {
    result.push(item);
    if (result.length === 20) break;
  }
  return result;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return new Response(JSON.stringify({ success: false, error: "Method not allowed" }), { status: 405, headers: corsHeaders });
  if (cache && cache.expiresAt > Date.now()) return new Response(JSON.stringify(cache.data), { headers: { ...corsHeaders, "Cache-Control": "public, max-age=600", "X-Cache": "HIT" } });

  const apiKey = Deno.env.get("SERPER_API_KEY");
  if (!apiKey) return new Response(JSON.stringify({ success: false, error: "热点服务尚未配置检索密钥。" }), { status: 503, headers: corsHeaders });

  try {
    const settled = await Promise.allSettled([...searches.map((entry) => searchSource(entry, apiKey)), ...rssFeeds.map(fetchRssFeed)]);
    const errors = settled.filter((result) => result.status === "rejected").length;
    const seenUrls = new Set<string>();
    const candidates = settled.flatMap((result) => result.status === "fulfilled" ? result.value : []).filter((item) => !seenUrls.has(item.url) && seenUrls.add(item.url));
    const selected = diversify(deduplicateEvents(candidates));
    const translated = await translateItems(selected);
    const items = translated.items.map((item, index) => ({ ...item, rank: index + 1, heat: qualityScore(item) }));

    if (!items.length) throw new Error("No high-quality game news results available");
    const data = { success: true, updatedAt: new Date().toISOString(), items, sources: [...new Set(items.map((item) => item.source))], unavailableSourceCount: errors };
    cache = { data, expiresAt: Date.now() + 10 * 60_000 };
    return new Response(JSON.stringify(data), { headers: { ...corsHeaders, "Cache-Control": "public, max-age=600", "X-Cache": "MISS" } });
  } catch (error) {
    console.error("game-hotspots failed", error);
    return new Response(JSON.stringify({ success: false, error: "暂无符合筛选标准的游戏新闻，请稍后刷新。" }), { status: 502, headers: corsHeaders });
  }
});
