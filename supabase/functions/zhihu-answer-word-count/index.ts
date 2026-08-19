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

function parseAnswerId(articleUrl: unknown) {
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

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ success: false, error: "Method not allowed" }, 405);

  try {
    const { articleUrl } = await req.json();
    const answerId = parseAnswerId(articleUrl);
    if (!answerId) return json({ success: false, error: "仅支持有效的知乎回答链接" }, 400);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    let zhihuRes: Response;
    try {
      zhihuRes = await fetch(`https://www.zhihu.com/api/v4/answers/${answerId}?include=content`, {
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; Keyflow/1.0)",
          "Accept": "application/json, text/plain, */*",
        },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }

    if (!zhihuRes.ok) {
      const detail = (await zhihuRes.text()).slice(0, 200);
      return json({ success: false, error: `知乎接口请求失败（HTTP ${zhihuRes.status}）`, detail }, 502);
    }
    if (!(zhihuRes.headers.get("content-type") || "").includes("application/json")) {
      return json({ success: false, error: "知乎接口返回了非 JSON 响应" }, 502);
    }

    let payload;
    try {
      payload = await zhihuRes.json();
    } catch {
      return json({ success: false, error: "知乎接口返回的 JSON 无法解析" }, 502);
    }
    const content = payload?.data?.content ?? payload?.content;
    if (typeof content !== "string") return json({ success: false, error: "未找到知乎回答正文" }, 404);

    const text = content
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<[^>]*>/g, "")
      .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
      .replace(/&#x([\da-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
      .replace(/&nbsp;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">");
    return json({ success: true, wordCount: [...text].length });
  } catch (e) {
    const message = e instanceof Error && e.name === "AbortError"
      ? "知乎接口请求超时，请稍后重试"
      : "知乎回答字数抓取失败，请稍后重试";
    const detail = e instanceof Error ? e.message : "unknown error";
    return json({ success: false, error: message, detail }, e instanceof Error && e.name === "AbortError" ? 504 : 500);
  }
});
