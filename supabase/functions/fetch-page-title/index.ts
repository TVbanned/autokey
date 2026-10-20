import { serve } from "https://deno.land/std@0.177.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function json(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" },
  });
}

function decodeEntities(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&#x2F;/gi, "/")
    .replace(/&nbsp;/g, " ");
}

function cleanTitle(title: string): string {
  return title
    .replace(/\s+/g, " ")
    .replace(/_微信公众号$/i, "")
    .replace(/[-–—|·]\s*(微信公众号|小红书|知乎)\s*$/i, "")
    .trim();
}

function extractTitle(html: string): string {
  const metaPatterns = [
    /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["']/i,
    /<meta[^>]+name=["']twitter:title["'][^>]+content=["']([^"']+)["']/i,
  ];
  for (const pattern of metaPatterns) {
    const match = html.match(pattern);
    if (match?.[1]) return cleanTitle(decodeEntities(match[1]));
  }
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (titleMatch?.[1]) return cleanTitle(decodeEntities(titleMatch[1]));
  // 小红书等 SPA 兜底：从 __INITIAL_STATE__ 里取 note title
  const stateMatch = html.match(/window\.__INITIAL_STATE__\s*=\s*(\{[\s\S]*?\})\s*<\/script>/i);
  if (stateMatch?.[1]) {
    const noteMatch = stateMatch[1].match(/"title"\s*:\s*"((?:[^"\\]|\\.)*)"/i);
    if (noteMatch?.[1]) {
      try { return cleanTitle(JSON.parse('"' + noteMatch[1] + '"')) } catch { return cleanTitle(noteMatch[1]) }
    }
  }
  return "";
}

function stripTags(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<br\s*\/?\s*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .trim();
}

function extractSiteName(html: string, url: string): string {
  const meta = html.match(/<meta[^>]+property=["']og:site_name["'][^>]+content=["']([^"']+)["']/i)
    || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:site_name["']/i);
  if (meta?.[1]) return decodeEntities(meta[1]).trim();
  try {
    const host = new URL(url).hostname;
    if (host.includes("mp.weixin.qq.com")) return "微信公众号";
    if (host.includes("xiaohongshu.com")) return "小红书";
  } catch {}
  return "";
}

function extractContent(html: string): string {
  let body = html;
  const start = html.search(/<div[^>]+id=["']js_content["']/i);
  if (start >= 0) body = html.slice(start);
  const blocks = [...body.matchAll(/<(?:p|h[1-6]|li|blockquote)[^>]*>([\s\S]*?)<\/(?:p|h[1-6]|li|blockquote)>/gi)]
    .map((m) => decodeEntities(stripTags(m[1])))
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  let text = blocks.join("\n");
  if (text.length < 40) {
    const stateMatch = html.match(/window\.__INITIAL_STATE__\s*=\s*(\{[\s\S]*?\})\s*<\/script>/i);
    const descMatch = stateMatch?.[1]?.match(/"desc"\s*:\s*"((?:[^"\\]|\\.)*)"/i);
    if (descMatch?.[1]) {
      try { text = JSON.parse('"' + descMatch[1] + '"') } catch { text = descMatch[1] }
    }
  }
  return text.replace(/\s+/g, " ").trim().slice(0, 1500);
}

interface StoreProduct {
  title: string;
  desc: string;
  cover: string;
  release_date: string | null;
  publisher: string;
  genre: string;
  screenshots: string[];
}

function absoluteUrl(value: string, baseUrl: string): string {
  const decoded = decodeEntities(value).trim();
  if (!decoded) return "";
  try {
    return new URL(decoded.startsWith("//") ? `https:${decoded}` : decoded, baseUrl).href;
  } catch {
    return "";
  }
}

function parseChineseDate(value: string): string | null {
  const match = decodeEntities(value).match(/(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/);
  if (!match) return null;
  return `${match[1]}-${String(Number(match[2])).padStart(2, "0")}-${String(Number(match[3])).padStart(2, "0")}T00:00:00+08:00`;
}

function extractMetaContent(html: string, names: string[]): string {
  for (const name of names) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const patterns = [
      new RegExp(`<meta\\b[^>]*(?:name|property)=["']${escaped}["'][^>]*content=["']([^"']+)["'][^>]*>`, "i"),
      new RegExp(`<meta\\b[^>]*content=["']([^"']+)["'][^>]*(?:name|property)=["']${escaped}["'][^>]*>`, "i"),
    ];
    for (const pattern of patterns) {
      const match = html.match(pattern);
      if (match?.[1]) return decodeEntities(match[1]).trim();
    }
  }
  return "";
}

function normalizeProductDate(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const trimmed = value.trim();
  const iso = trimmed.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (iso) {
    return `${iso[1]}-${String(Number(iso[2])).padStart(2, "0")}-${String(Number(iso[3])).padStart(2, "0")}T00:00:00+08:00`;
  }
  return parseChineseDate(trimmed);
}

function namesFromJsonLd(value: unknown): string {
  if (typeof value === "string") return decodeEntities(value).trim();
  if (Array.isArray(value)) return value.map(namesFromJsonLd).filter(Boolean).join(", ");
  if (value && typeof value === "object") {
    const item = value as Record<string, unknown>;
    return namesFromJsonLd(item.name || item["@id"] || "");
  }
  return "";
}

function productFromJsonLd(html: string, baseUrl: string): Partial<StoreProduct> {
  for (const match of html.matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const parsed = JSON.parse(decodeEntities(match[1]));
      const queue: unknown[] = Array.isArray(parsed) ? [...parsed] : [parsed];
      while (queue.length) {
        const node = queue.shift();
        if (!node || typeof node !== "object") continue;
        const item = node as Record<string, unknown>;
        if (Array.isArray(item["@graph"])) queue.push(...item["@graph"]);
        const types = Array.isArray(item["@type"]) ? item["@type"] : [item["@type"]];
        const isGameProduct = types.some((type) => /VideoGame|Product|SoftwareApplication/i.test(String(type || "")));
        if (!isGameProduct) continue;
        const images = Array.isArray(item.image) ? item.image : [item.image];
        const imageUrls = images
          .map((image) => typeof image === "string" ? image : (image as Record<string, unknown> | null)?.url)
          .filter((image): image is string => typeof image === "string" && !!image)
          .map((image) => absoluteUrl(image, baseUrl));
        return {
          title: namesFromJsonLd(item.name || item.headline),
          desc: namesFromJsonLd(item.description),
          cover: imageUrls[0] || "",
          release_date: normalizeProductDate(item.releaseDate || item.datePublished),
          publisher: namesFromJsonLd(item.publisher || item.brand || item.author),
          genre: namesFromJsonLd(item.genre),
          screenshots: imageUrls.slice(1, 5),
        };
      }
    } catch {}
  }
  return {};
}

function extractGenericProduct(html: string, url: string): StoreProduct | null {
  const jsonLd = productFromJsonLd(html, url);
  const siteName = extractSiteName(html, url);
  const title = decodeEntities(extractMetaContent(html, ["og:title", "twitter:title"]) || extractTitle(html))
    .replace(siteName ? new RegExp(`\\s*[-–—|]\\s*${siteName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "i") : /$^/, "")
    .trim();
  const desc = decodeEntities(extractMetaContent(html, ["og:description", "description", "twitter:description"]))
    .replace(/\s+/g, " ")
    .trim();
  const cover = absoluteUrl(
    extractMetaContent(html, ["og:image", "twitter:image", "twitter:image:src"]),
    url,
  );
  const merged = {
    title: jsonLd.title || title,
    desc: jsonLd.desc || desc,
    cover: jsonLd.cover || cover,
    release_date: jsonLd.release_date || null,
    publisher: jsonLd.publisher || "",
    genre: jsonLd.genre || "",
    screenshots: jsonLd.screenshots || [],
  };
  if (!merged.title && !merged.desc && !merged.cover) return null;
  return merged;
}

function extractUbisoftProduct(html: string, url: string): StoreProduct | null {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    return null;
  }
  const host = parsedUrl.hostname;
  const isUbisoftHost = host === "ubisoft.com" || host.endsWith(".ubisoft.com")
    || host === "ubi.com" || host.endsWith(".ubi.com");
  if (!isUbisoftHost || !/\/games\/[^/]+/i.test(parsedUrl.pathname)) return null;

  const heroTitle = html.match(/<h2\b[^>]*data-innertext=["']([^"']+)["'][^>]*>[\s\S]*?<\/h2>/i);
  const title = decodeEntities(heroTitle?.[1] || extractTitle(html)
    .replace(/[-–—|]\s*游戏\s*[-–—|]\s*育碧游戏官方网站\s*$/i, "")
    .trim());
  const heroDescription = html.match(/<h2\b[^>]*data-innertext=["'][^"']+["'][^>]*>[\s\S]*?<\/h2>\s*<p[^>]*>([\s\S]*?)<\/p>/i);
  const desc = decodeEntities(stripTags(heroDescription?.[1] || "")).replace(/\s+/g, " ").trim();
  const heroImage = html.match(/data-herobg=["']([^"']+)["']/i);
  const cover = absoluteUrl(heroImage?.[1] || "", url);

  const releaseBlock = html.match(/productDetail__releaseDate[^>]*>([\s\S]*?)<\/div>/i);
  const releaseDate = parseChineseDate(stripTags(releaseBlock?.[1] || ""));
  const genreBlock = html.match(/productDetail__genre[^>]*>([\s\S]*?)<\/div>/i);
  const developerBlock = html.match(/productDetail__developer[^>]*>([\s\S]*?)<\/div>/i);
  const genre = decodeEntities(stripTags(genreBlock?.[1] || "")).replace(/^类型\s*[:：]\s*/i, "").trim();
  const publisher = decodeEntities(stripTags(developerBlock?.[1] || "")).replace(/^开发商\s*[:：]\s*/i, "").trim();

  const screenshots: string[] = [];
  for (const match of html.matchAll(/<img\b[^>]*class=["'][^"']*tabs__item__media__image[^"']*["'][^>]*src=["']([^"']+)["']/gi)) {
    const screenshot = absoluteUrl(match[1], url);
    if (screenshot && !screenshots.includes(screenshot)) screenshots.push(screenshot);
    if (screenshots.length >= 4) break;
  }

  if (!title) return null;
  return { title, desc, cover, release_date: releaseDate, publisher, genre, screenshots };
}

async function enrichUbisoftProduct(product: StoreProduct, gameHtml: string, pageUrl: string): Promise<StoreProduct> {
  const buyMatch = gameHtml.match(/<a\b[^>]*class=["'][^"']*\bstore-buy\b[^"']*["'][^>]*href=["']([^"']+)["']/i)
    || gameHtml.match(/<a\b[^>]*href=["']([^"']+)["'][^>]*class=["'][^"']*\bstore-buy\b[^"']*["']/i);
  const storeMatch = gameHtml.match(/https:\/\/store\.ubisoft\.com\/[^"'\s<>]+/i);
  const storeUrl = absoluteUrl(buyMatch?.[1] || storeMatch?.[0] || "", pageUrl);
  if (!storeUrl) return product;

  try {
    const response = await fetch(storeUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/123.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml",
        "Accept-Language": "zh-CN,zh;q=0.9",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) return product;
    const finalStoreUrl = response.url || storeUrl;
    const storeHtml = await response.text();
    const storeProduct = extractGenericProduct(storeHtml, finalStoreUrl);
    const gallery: string[] = [];
    for (const match of storeHtml.matchAll(/https:\/\/store\.ubisoft\.com\/on\/demandware\.static\/[^"'\s<>]+?\/images\/large\/[^"'\s<>]+?\.(?:jpe?g|png|webp)/gi)) {
      const image = decodeEntities(match[0]);
      if (image !== storeProduct?.cover && !/noimage/i.test(image) && !gallery.includes(image)) gallery.push(image);
      if (gallery.length >= 4) break;
    }
    return {
      ...product,
      desc: storeProduct?.desc || product.desc,
      cover: storeProduct?.cover || product.cover,
      publisher: storeProduct?.publisher || product.publisher,
      screenshots: gallery.length ? gallery : product.screenshots,
    };
  } catch {
    return product;
  }
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ success: false, error: "Method not allowed" }, 405);
  try {
    const body = await req.json().catch(() => ({}));
    const url = typeof body.url === "string" ? body.url.trim() : "";
    if (!/^https?:\/\/.+/i.test(url)) return json({ success: false, error: "请输入有效的链接" }, 400);
    const response = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) return json({ success: false, error: `链接抓取失败（HTTP ${response.status}），可能是站点拦截了访问` }, 502);
    const html = await response.text();
    const title = extractTitle(html);
    const content = extractContent(html);
    const siteName = extractSiteName(html, url);
    let product = extractUbisoftProduct(html, url) || extractGenericProduct(html, url);
    if (product && /(?:^|\.)ubisoft\.com$|(?:^|\.)ubi\.com$/i.test(new URL(url).hostname)) {
      product = await enrichUbisoftProduct(product, html, url);
    }
    if (!title) return json({ success: false, error: "未能识别到文章标题，该站点可能开启了访问拦截" }, 422);
    return json({ success: true, title, content, siteName, url, ...(product ? { product } : {}) });
  } catch (error) {
    return json({ success: false, error: error instanceof Error ? error.message : "链接抓取失败" }, 502);
  }
});
