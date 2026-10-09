import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { buildDeals, type DealsPayload } from "./aggregate.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// 上游刷新节奏：Epic 一周一换、Steam 折扣按小时级、GamerPower 随时补录。
// 30 分钟缓存足够新鲜，同时避免每次打开看板都去打三个外部站点。
const CACHE_TTL_MS = 30 * 60 * 1000;
let cache: { at: number; payload: DealsPayload } | null = null;
let inflight: Promise<DealsPayload> | null = null;

function json(body: unknown, status = 200, extraHeaders: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8", ...extraHeaders },
  });
}

async function load(force: boolean): Promise<{ payload: DealsPayload; state: string }> {
  const now = Date.now();
  if (!force && cache && now - cache.at < CACHE_TTL_MS) {
    return { payload: cache.payload, state: "HIT" };
  }
  // 并发请求共用同一次上游抓取，避免缓存过期瞬间打出多倍请求
  if (!inflight) {
    inflight = buildDeals()
      .then((payload) => {
        cache = { at: Date.now(), payload };
        return payload;
      })
      .finally(() => {
        inflight = null;
      });
  }
  return { payload: await inflight, state: "MISS" };
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  // 前端走 supabase.functions.invoke（POST），所以 refresh 同时支持 query 和 body 两种传法
  let force = new URL(req.url).searchParams.get("refresh") === "1";
  if (!force && req.method === "POST") {
    try {
      const body = await req.json();
      force = body?.refresh === true || body?.refresh === 1 || body?.refresh === "1";
    } catch {
      // 没有 body 或不是 JSON，按未强制刷新处理
    }
  }

  try {
    const { payload, state } = await load(force);
    return json({ ...payload, cached: state === "HIT" }, 200, { "X-Cache": state });
  } catch (error) {
    console.error("deals aggregation failed", error);
    // 抓取失败但手里还有旧数据时，宁可给旧数据也不要开天窗
    if (cache) {
      return json({ ...cache.payload, cached: true, stale: true }, 200, { "X-Cache": "STALE" });
    }
    const message = error instanceof Error ? error.message : "福利数据抓取失败，请稍后重试";
    return json({ success: false, error: message }, 502);
  }
});
