// 知乎短回答链接解析：zhihu.com/answer/<答案id> → 所属问题 id + 标准链接
// 用途：答主用「分享-链接」拿到的短链接没有题目 ID，前端无法判定是否命中综合活动题库。
// 入参（三选一）：
//   { "url": "https://www.zhihu.com/answer/2083890157300748838" }  单条
//   { "answer_id": "2083890157300748838" }                         单条
//   { "answer_ids": ["...", "..."] }                               批量（最多 60 条）
// 出参：{ success, results: { "<答案id>": { answer_id, question_id, question_title, canonical_url } }, first }
// 说明：调用知乎公开接口 https://www.zhihu.com/api/v4/answers/<id>?include=question，
//       需要带上知乎登录 Cookie（与 zhihu-following-questions 共用同一组密钥），
//       否则机房 IP 会被知乎风控拦成 403（need_login / unhuman 挑战）。

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36";

function zhihuHeaders(): Record<string, string> {
  const dC0 = Deno.env.get("ZHIHU_D_C0");
  const zC0 = Deno.env.get("ZHIHU_Z_C0");
  const zap = Deno.env.get("ZHIHU_ZAP");
  const cookie = [`d_c0=${dC0}`, `z_c0=${zC0}`, zap ? `_zap=${zap}` : ""]
    .filter((item) => !item.endsWith("=undefined"))
    .join("; ");
  return {
    "User-Agent": UA,
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "zh-CN,zh;q=0.9",
    "Referer": "https://www.zhihu.com/",
    ...(cookie ? { Cookie: cookie } : {}),
  };
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// 支持完整链接、短链接、api 链接、纯数字 id
function parseAnswerId(input: string): string | null {
  const text = String(input ?? "").trim();
  if (!text) return null;
  if (/^\d{6,}$/.test(text)) return text;
  const matched = text.match(/zhihu\.com\/(?:api\/v4\/)?(?:question\/\d+\/)?answer[s]?\/(\d{6,})/i);
  return matched?.[1] ?? null;
}

type Resolved = {
  answer_id: string;
  question_id?: string;
  question_title?: string;
  canonical_url?: string;
  error?: string;
  detail?: string;
};

async function resolveOne(answerId: string): Promise<Resolved> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);
  try {
    const res = await fetch(`https://www.zhihu.com/api/v4/answers/${answerId}?include=question`, {
      headers: zhihuHeaders(),
      signal: controller.signal,
    });
    if (!res.ok) {
      const snippet = (await res.text()).slice(0, 200);
      return { answer_id: answerId, error: `知乎接口返回 ${res.status}`, detail: snippet };
    }
    if (!(res.headers.get("content-type") || "").includes("application/json")) {
      return { answer_id: answerId, error: "知乎接口返回了非 JSON 响应" };
    }
    const payload: any = await res.json();
    const question = payload?.question ?? payload?.data?.question ?? null;
    const questionId = question?.id != null ? String(question.id) : null;
    if (!questionId) return { answer_id: answerId, error: "未取到所属问题" };
    return {
      answer_id: answerId,
      question_id: questionId,
      question_title: typeof question?.title === "string" ? question.title : "",
      canonical_url: `https://www.zhihu.com/question/${questionId}/answer/${answerId}`,
    };
  } catch (err) {
    return { answer_id: answerId, error: String(err) };
  } finally {
    clearTimeout(timer);
  }
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ success: false, error: "Method not allowed" }, 405);

  try {
    const body: any = await req.json().catch(() => ({}));
    const ids: string[] = [];

    if (Array.isArray(body?.answer_ids)) {
      for (const item of body.answer_ids) {
        const id = parseAnswerId(String(item));
        if (id) ids.push(id);
      }
    }
    const single = parseAnswerId(String(body?.answer_id ?? body?.url ?? body?.articleUrl ?? ""));
    if (single) ids.push(single);

    if (!ids.length) {
      return json({ success: false, error: "请提供知乎回答链接或 answer_id" }, 400);
    }

    const unique = [...new Set(ids)].slice(0, 60);
    const results = await Promise.all(unique.map(resolveOne));
    return json({
      success: true,
      results: Object.fromEntries(results.map((item) => [item.answer_id, item])),
      first: results[0] ?? null,
    });
  } catch (err) {
    return json({ success: false, error: String(err) }, 500);
  }
});
