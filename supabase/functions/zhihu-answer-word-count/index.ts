import { serve } from "https://deno.land/std@0.177.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function json(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function parseAnswerId(articleUrl: unknown): string | null {
  if (typeof articleUrl !== "string") return null;
  let url: URL;
  try {
    url = new URL(articleUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || !["www.zhihu.com", "zhihu.com"].includes(url.hostname)) return null;

  const questionAnswer = url.pathname.match(/^\/question\/\d+\/answer\/(\d+)\/?$/);
  const shortAnswer = url.pathname.match(/^\/answer\/(\d+)\/?$/);
  return questionAnswer?.[1] || shortAnswer?.[1] || null;
}

function parseArticleId(articleUrl: unknown): string | null {
  if (typeof articleUrl !== "string") return null;
  let url: URL;
  try {
    url = new URL(articleUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.hostname !== "zhuanlan.zhihu.com") return null;
  return url.pathname.match(/^\/p\/(\d+)\/?$/)?.[1] || null;
}

function htmlToText(content: string): string {
  return content
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]*>/g, "")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([\da-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

function findArticleContent(node: unknown, articleId: string, depth = 0): string | null {
  if (node === null || node === undefined || typeof node !== "object" || depth > 20) return null;
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findArticleContent(item, articleId, depth + 1);
      if (found) return found;
    }
    return null;
  }
  const record = node as Record<string, unknown>;
  const id = record["id"] ?? record["article_id"] ?? record["articleId"];
  if (typeof record["content"] === "string" && String(id ?? "") === String(articleId)) {
    return record["content"] as string;
  }
  for (const [key, value] of Object.entries(record)) {
    if (
      key === String(articleId) &&
      typeof value === "object" &&
      value !== null &&
      typeof (value as Record<string, unknown>)["content"] === "string"
    ) {
      return (value as Record<string, unknown>)["content"] as string;
    }
    if (key === "content" && typeof value === "string" && value.length > 20 && /<[a-z][^>]*>/i.test(value)) {
      return value;
    }
    const found = findArticleContent(value, articleId, depth + 1);
    if (found) return found;
  }
  return null;
}

function extractArticleContent(html: string, articleId: string): string | null {
  const scriptBlocks = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]);
  for (const raw of scriptBlocks) {
    let text = raw.trim();
    if (!text.startsWith("{")) {
      const start = text.indexOf("{");
      if (start < 0) continue;
      text = text.slice(start);
    }
    const lastBrace = text.lastIndexOf("}");
    if (lastBrace > 0) text = text.slice(0, lastBrace + 1);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      continue;
    }
    const content = findArticleContent(parsed, articleId);
    if (content) return content;
  }
  return null;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ success: false, error: "Method not allowed" }, 405);

  try {
    const { articleUrl } = await req.json();
    const answerId = parseAnswerId(articleUrl);
    const articleId = parseArticleId(articleUrl);
    if (!answerId && !articleId) return json({ success: false, error: "仅支持有效的知乎回答或专栏文章链接" }, 400);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12_000);
    let content: string | null = null;
    let failStatus = 0;
    let failDetail = "";
    try {
      if (answerId) {
        const zhihuRes = await fetch(`https://www.zhihu.com/api/v4/answers/${answerId}?include=content`, {
          headers: {
            "User-Agent": "Mozilla/5.0 (compatible; Keyflow/1.0)",
            "Accept": "application/json, text/plain, */*",
          },
          signal: controller.signal,
        });
        if (!zhihuRes.ok) {
          failStatus = zhihuRes.status;
          failDetail = (await zhihuRes.text()).slice(0, 200);
        } else if (!(zhihuRes.headers.get("content-type") || "").includes("application/json")) {
          failDetail = "知乎接口返回了非 JSON 响应";
        } else {
          const payload: any = await zhihuRes.json();
          const raw = payload?.data?.content ?? payload?.content;
          if (typeof raw === "string") content = raw;
        }
      } else if (articleId) {
        // 1) 先走专栏文章接口
        const apiRes = await fetch(`https://www.zhihu.com/api/v4/articles/${articleId}?include=content`, {
          headers: {
            "User-Agent": "Mozilla/5.0 (compatible; Keyflow/1.0)",
            "Accept": "application/json, text/plain, */*",
          },
          signal: controller.signal,
        });
        if (apiRes.ok) {
          try {
            const payload: any = await apiRes.json();
            const raw = payload?.data?.content ?? payload?.content;
            if (typeof raw === "string") content = raw;
          } catch {
            // JSON 解析失败时继续走页面兜底
          }
        } else {
          failStatus = apiRes.status;
          failDetail = (await apiRes.text()).slice(0, 200);
        }
        // 2) 接口拿不到正文时退回页面内嵌数据
        if (!content) {
          const pageRes = await fetch(`https://zhuanlan.zhihu.com/p/${articleId}`, {
            headers: {
              "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
              "Accept": "text/html,application/xhtml+xml",
            },
            signal: controller.signal,
          });
          if (pageRes.ok) {
            content = extractArticleContent(await pageRes.text(), articleId);
          } else if (!failStatus) {
            failStatus = pageRes.status;
            failDetail = (await pageRes.text()).slice(0, 200);
          }
        }
      }
    } finally {
      clearTimeout(timeout);
    }

    if (!content) {
      if (!answerId && failStatus) {
        return json({ success: false, error: `知乎专栏文章抓取失败（HTTP ${failStatus}）`, detail: failDetail }, 502);
      }
      if (failStatus) {
        return json({ success: false, error: `知乎接口请求失败（HTTP ${failStatus}）`, detail: failDetail }, 502);
      }
      return json({ success: false, error: answerId ? "未找到知乎回答正文" : "未找到知乎专栏文章正文" }, 404);
    }

    const text = htmlToText(content);
    return json({ success: true, wordCount: [...text].length });
  } catch (e) {
    const message = e instanceof Error && e.name === "AbortError"
      ? "知乎接口请求超时，请稍后重试"
      : "知乎字数抓取失败，请稍后重试";
    const detail = e instanceof Error ? e.message : "unknown error";
    return json({ success: false, error: message, detail }, e instanceof Error && e.name === "AbortError" ? 504 : 500);
  }
});
