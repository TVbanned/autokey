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
    if (!title) return json({ success: false, error: "未能识别到文章标题，该站点可能开启了访问拦截" }, 422);
    return json({ success: true, title, content, siteName, url });
  } catch (error) {
    return json({ success: false, error: error instanceof Error ? error.message : "链接抓取失败" }, 502);
  }
});