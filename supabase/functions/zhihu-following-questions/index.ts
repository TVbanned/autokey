import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
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

async function isAdmin(token: unknown) {
  if (typeof token !== "string" || !token) return false;
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );
  const { data } = await supabase
    .from("keyflow_admin_users")
    .select("id")
    .eq("session_token", token)
    .maybeSingle();
  return Boolean(data?.id);
}

function toCount(value: unknown) {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value === "string") return Number(value.replace(/,/g, "")) || 0;
  return 0;
}

// 知乎 API 返回的 url 是 /api/v4/questions/{id}，统一转为公开地址 /question/{id}，
// 避免同一问题因地址形式不同在收藏表中重复入库。
function publicQuestionUrl(raw: string): string {
  const clean = raw.split("#")[0].split("?")[0].replace(/\/+$/, "");
  return clean.replace(/\/api\/v4\/questions\/(\d+)$/, "/question/$1");
}

function questionFrom(item: Record<string, unknown>) {
  const question = item.question && typeof item.question === "object"
    ? item.question as Record<string, unknown>
    : item;
  const answerCount = question.answer_count ?? question.answerCount ?? question.answers_count ?? item.answer_count ?? item.answerCount;
  const followerCount = question.follower_count ?? question.followerCount ?? question.followers_count ?? item.follower_count ?? item.followerCount;
  const rawUrl = typeof question.url === "string" ? question.url : `https://www.zhihu.com/question/${question.id ?? item.id}`;
  return {
    title: typeof question.title === "string" ? question.title : "",
    url: publicQuestionUrl(rawUrl),
    answerCount: toCount(answerCount),
    followerCount: toCount(followerCount),
  };
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ success: false, error: "Method not allowed" }, 405);

  try {
    const body = await req.json().catch(() => ({}));
    if (!(await isAdmin(body.adminToken))) return json({ success: false, error: "无权访问" }, 401);

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );
    const cacheKey = "configured-account";
    if (!body.forceRefresh) {
      const { data: cached } = await supabase
        .from("keyflow_zhihu_questions_cache")
        .select("questions, zhihu_user, fetched_at")
        .eq("cache_key", cacheKey)
        .maybeSingle();
      if (cached?.questions) {
        return json({ success: true, questions: cached.questions, user: cached.zhihu_user || {}, fetchedAt: cached.fetched_at, cached: true });
      }
    }

    const dC0 = Deno.env.get("ZHIHU_D_C0");
    const zC0 = Deno.env.get("ZHIHU_Z_C0");
    const zap = Deno.env.get("ZHIHU_ZAP");
    if (!dC0 || !zC0) return json({ success: false, error: "知乎 Cookie 未配置" }, 500);

    const cookie = [`d_c0=${dC0}`, `z_c0=${zC0}`, zap ? `_zap=${zap}` : ""].filter(Boolean).join("; ");
    const headers = {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/123 Safari/537.36",
      "Accept": "application/json, text/plain, */*",
      "Cookie": cookie,
    };

    const meResponse = await fetch("https://www.zhihu.com/api/v4/me", { headers });
    if (!meResponse.ok) return json({ success: false, error: `知乎登录验证失败（HTTP ${meResponse.status}）` }, 502);
    const me = await meResponse.json();
    const urlToken = me?.url_token;
    if (!urlToken) return json({ success: false, error: "知乎用户信息中没有 url_token" }, 502);

    const questions: ReturnType<typeof questionFrom>[] = [];
    const include = "data[*].title,url,answer_count,follower_count,visit_count";
    let next = `https://www.zhihu.com/api/v4/members/${encodeURIComponent(urlToken)}/following-questions?limit=20&include=${encodeURIComponent(include)}`;
    while (next && questions.length < 100) {
      const response = await fetch(next, { headers });
      if (!response.ok) return json({ success: false, error: `知乎关注问题请求失败（HTTP ${response.status}）` }, 502);
      const payload = await response.json();
      for (const item of payload?.data || []) {
        if (item && typeof item === "object") questions.push(questionFrom(item));
        if (questions.length >= 100) break;
      }
      next = typeof payload?.paging?.next === "string" ? payload.paging.next : "";
    }

    const zhihuUser = { name: me.name || "", urlToken };
    const { error: cacheError } = await supabase
      .from("keyflow_zhihu_questions_cache")
      .upsert({ cache_key: cacheKey, questions, zhihu_user: zhihuUser, fetched_at: new Date().toISOString(), updated_at: new Date().toISOString() });
    if (cacheError) console.error("zhihu questions cache update failed", cacheError);

    return json({ success: true, questions, user: zhihuUser, fetchedAt: new Date().toISOString(), cached: false });
  } catch (error) {
    console.error("zhihu-following-questions failed", error);
    return json({ success: false, error: error instanceof Error ? error.message : "关注问题获取失败" }, 500);
  }
});
