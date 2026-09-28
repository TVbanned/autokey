// 知乎短链兜底补全：把库里「只有回答 ID、没有题目 ID」的投稿链接补成标准链接，
// 顺手把缺失/占位的标题（例如粘贴成「知乎」）补成真实问题标题，最后重算命中与奖励。
//
// 为什么需要：答主从知乎「分享 - 复制链接」拿到的是 https://www.zhihu.com/answer/<回答ID>，
// 提交时前端会先调 resolve-zhihu-answer 补全；但刚发布的回答知乎接口可能还查不到
// （实测有答主在发布后 10 秒就投稿），于是按短链入库 → 命中判定拿不到题目 ID
// → 答主看到「没有命中题目」。本函数做服务端兜底：过一会儿自动补回链接、标题和活动进度。
//
// 入参（可省略）：
//   { "answerer_id": "<答主 uuid>", "limit": 200 }
// 出参：{ ok, scanned, pending, resolved, updated, skipped, duplicates, settled }
// 说明：调用知乎公开接口 https://www.zhihu.com/api/v4/answers/<id>?include=question，
//       与 resolve-zhihu-answer 共用同一组登录 Cookie 密钥（ZHIHU_D_C0 / ZHIHU_Z_C0 / ZHIHU_ZAP）。

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const ZHIHU_ANSWER_API = "https://www.zhihu.com/api/v4/answers";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36";
const BATCH = 40;
const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 500;
// 明显不是真实标题的占位值：空、知乎兜底标题、链接本身
const PLACEHOLDER_TITLES = new Set(["知乎", "知乎 - 知乎", "zhihu"]);

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

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

const ANSWER_ID_PATTERN = /zhihu\.com\/(?:api\/v4\/)?(?:question\/\d+\/)?answers?\/(\d{6,})/i;
const QUESTION_ID_PATTERN = /zhihu\.com\/(?:question|api\/v4\/questions)\/(\d+)/i;
const ARTICLE_ID_PATTERN = /zhuanlan\.zhihu\.com\/p\/(\d{6,})/i;

function answerIdOf(url: unknown): string | null {
  return String(url ?? "").match(ANSWER_ID_PATTERN)?.[1] ?? null;
}

function hasQuestionId(url: unknown): boolean {
  return QUESTION_ID_PATTERN.test(String(url ?? ""));
}

function questionIdOf(url: unknown): string | null {
  return String(url ?? "").match(QUESTION_ID_PATTERN)?.[1] ?? null;
}

function articleIdOf(url: unknown): string | null {
  return String(url ?? "").match(ARTICLE_ID_PATTERN)?.[1] ?? null;
}

function isPlaceholderTitle(title: unknown, url: unknown): boolean {
  const text = String(title ?? "").trim();
  if (!text) return true;
  if (text === String(url ?? "").trim()) return true;
  return PLACEHOLDER_TITLES.has(text);
}

type Resolved = { answer_id: string; question_id?: string; question_title?: string; canonical_url?: string };

function decodeEntities(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&nbsp;/g, " ");
}

// 专栏文章没有「所属问题」，标题就是文章标题。
// 文章接口要签名（直接调会 403「请升级客户端」），这里读公开页面的 og:title / <title>。
async function resolveArticleTitle(articleId: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);
  try {
    const res = await fetch(`https://zhuanlan.zhihu.com/p/${articleId}`, {
      headers: {
        "User-Agent": UA,
        "Accept": "text/html,application/xhtml+xml",
        "Accept-Language": "zh-CN,zh;q=0.9",
      },
      signal: controller.signal,
    });
    if (!res.ok) return "";
    const html = await res.text();
    const ogTitle = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i)
      ?? html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["']/i);
    const titleTag = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const raw = ogTitle?.[1] ?? titleTag?.[1] ?? "";
    const title = decodeEntities(raw).replace(/\s+/g, " ").replace(/\s*[-–—|·]\s*知乎\s*$/, "").trim();
    return title === "知乎" ? "" : title;
  } catch {
    return "";
  } finally {
    clearTimeout(timer);
  }
}

async function resolveOne(answerId: string): Promise<Resolved> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);
  try {
    const res = await fetch(`${ZHIHU_ANSWER_API}/${answerId}?include=question`, {
      headers: zhihuHeaders(),
      signal: controller.signal,
    });
    if (!res.ok) return { answer_id: answerId };
    if (!(res.headers.get("content-type") || "").includes("application/json")) return { answer_id: answerId };
    const payload: any = await res.json();
    const question = payload?.question ?? payload?.data?.question ?? null;
    const questionId = question?.id != null ? String(question.id) : null;
    if (!questionId) return { answer_id: answerId };
    return {
      answer_id: answerId,
      question_id: questionId,
      question_title: typeof question?.title === "string" ? question.title : "",
      canonical_url: `https://www.zhihu.com/question/${questionId}/answer/${answerId}`,
    };
  } catch {
    return { answer_id: answerId };
  } finally {
    clearTimeout(timer);
  }
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);

  try {
    const body: any = await req.json().catch(() => ({}));
    const answererId = typeof body?.answerer_id === "string" && body.answerer_id ? body.answerer_id : null;
    const limit = Math.min(Math.max(Number(body?.limit) || DEFAULT_LIMIT, 1), MAX_LIMIT);

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // ① 收集候选行：链接里带 /answer/ 但没带 /question/ 的都算待补全
    type Row = {
      table: string;
      id: string;
      answerer_id: string | null;
      activity_id?: string | null;
      article_url: string;
      article_title: string | null;
    };
    const rows: Row[] = [];

    const daily = supabase
      .from("keyflow_daily_submissions")
      .select("id,answerer_id,article_url,article_title")
      .like("article_url", "%zhihu.com/answer/%")
      .limit(limit);
    const comp = supabase
      .from("keyflow_comprehensive_submissions")
      .select("id,answerer_id,activity_id,article_url,article_title")
      .like("article_url", "%zhihu.com/answer/%")
      .limit(limit);
    // 交付表的答主要经 keyflow_applications 关联，指定 answerer_id 时按关联答主过滤
    const deliv = supabase
      .from("keyflow_deliveries")
      .select(answererId ? "id,article_url,article_title,keyflow_applications!inner(answerer_id)" : "id,article_url,article_title")
      .like("article_url", "%zhihu.com/answer/%")
      .limit(limit);

    const [dailyRes, compRes, delivRes] = await Promise.all([
      answererId ? daily.eq("answerer_id", answererId) : daily,
      answererId ? comp.eq("answerer_id", answererId) : comp,
      answererId ? deliv.eq("keyflow_applications.answerer_id", answererId) : deliv,
    ]);

    for (const r of dailyRes.data ?? []) rows.push({ table: "keyflow_daily_submissions", ...r });
    for (const r of compRes.data ?? []) rows.push({ table: "keyflow_comprehensive_submissions", ...r });
    for (const r of delivRes.data ?? []) {
      rows.push({
        table: "keyflow_deliveries",
        id: r.id,
        answerer_id: null,
        article_url: r.article_url,
        article_title: r.article_title,
      });
    }

    const pending = rows
      .map((row) => ({ ...row, answerId: answerIdOf(row.article_url) }))
      .filter((row) => row.answerId && !hasQuestionId(row.article_url));

    const resolvedById = new Map<string, Resolved>();
    let updated = 0;
    let skipped = 0;
    let duplicates = 0;
    let settled: unknown = null;

    if (pending.length) {
      // ② 批量解析（知乎接口并发即可，分批避免一次打太多）
      const uniqueIds = [...new Set(pending.map((row) => row.answerId!))];
      for (let i = 0; i < uniqueIds.length; i += BATCH) {
        const chunk = uniqueIds.slice(i, i + BATCH);
        const results = await Promise.all(chunk.map(resolveOne));
        for (const item of results) {
          if (item.canonical_url) resolvedById.set(item.answer_id, item);
        }
      }

      // ③ 回写链接 / 标题（标题只在明显是占位值时补，不动答主自己写对的名字）/ 题目链接
      for (const row of pending) {
        const hit = resolvedById.get(row.answerId!);
        if (!hit?.canonical_url || !hit.question_id) {
          skipped += 1;
          continue;
        }
        const patch: Record<string, unknown> = { article_url: hit.canonical_url };
        if (isPlaceholderTitle(row.article_title, row.article_url) && hit.question_title) {
          patch.article_title = hit.question_title;
        }
        if (row.table === "keyflow_comprehensive_submissions") {
          const bank = await supabase
            .from("keyflow_activity_questions")
            .select("question_url")
            .eq("question_id", hit.question_id)
            .limit(1)
            .maybeSingle();
          patch.question_url = bank.data?.question_url || `https://www.zhihu.com/question/${hit.question_id}`;
        }

        const { error } = await supabase.from(row.table).update(patch).eq("id", row.id);
        if (error) {
          // 23505：这条内容已经以完整链接投过一次（唯一索引/跨入口去重触发器），不覆盖已有行
          if (error.code === "23505" || /duplicate key|已在/.test(error.message || "")) duplicates += 1;
          else skipped += 1;
          continue;
        }
        updated += 1;
      }

      // ④ 命中变了就重算单题奖励 / 完成奖励（函数自身幂等，靠唯一键去重）
      if (updated > 0) {
        const { data, error } = await supabase.rpc("keyflow_rescan_comprehensive_hits", { p_activity_id: null });
        settled = error ? { error: error.message } : data;
      }
    }

    // ⑤ 标题兜底：链接已经是标准链接、但标题还是占位值（例如答主粘贴成「知乎」）的，
    //    按题目把名字补回来——优先用活动题库里的题干，题库没有的再问知乎。
    const titleTargets: Array<{ table: string; id: string; article_url: string }> = [];
    const placeholderTitles = ["", ...[...PLACEHOLDER_TITLES]];
    const titleDaily = supabase
      .from("keyflow_daily_submissions")
      .select("id,article_url")
      .in("article_title", placeholderTitles)
      .limit(limit);
    const titleComp = supabase
      .from("keyflow_comprehensive_submissions")
      .select("id,article_url")
      .in("article_title", placeholderTitles)
      .limit(limit);
    const titleDeliv = supabase
      .from("keyflow_deliveries")
      .select(answererId ? "id,article_url,keyflow_applications!inner(answerer_id)" : "id,article_url")
      .in("article_title", placeholderTitles)
      .limit(limit);
    const [titleDailyRes, titleCompRes, titleDelivRes] = await Promise.all([
      answererId ? titleDaily.eq("answerer_id", answererId) : titleDaily,
      answererId ? titleComp.eq("answerer_id", answererId) : titleComp,
      answererId ? titleDeliv.eq("keyflow_applications.answerer_id", answererId) : titleDeliv,
    ]);
    for (const r of titleDailyRes.data ?? []) titleTargets.push({ table: "keyflow_daily_submissions", ...r });
    for (const r of titleCompRes.data ?? []) titleTargets.push({ table: "keyflow_comprehensive_submissions", ...r });
    for (const r of titleDelivRes.data ?? []) titleTargets.push({ table: "keyflow_deliveries", id: r.id, article_url: r.article_url });

    // 先从活动题库取题干（快、不依赖知乎登录态）
    const bankQuestionIds = [...new Set(titleTargets.map((row) => questionIdOf(row.article_url)).filter(Boolean))] as string[];
    const bankTitleByQuestionId = new Map<string, string>();
    for (let i = 0; i < bankQuestionIds.length; i += BATCH) {
      const chunk = bankQuestionIds.slice(i, i + BATCH);
      const { data } = await supabase
        .from("keyflow_activity_questions")
        .select("question_id,question_text")
        .in("question_id", chunk);
      for (const q of data ?? []) {
        if (q.question_id && q.question_text) bankTitleByQuestionId.set(String(q.question_id), String(q.question_text));
      }
    }

    // 题库里没有的（非本次活动题目），退回知乎接口取问题标题
    const needZhihu = titleTargets
      .map((row) => ({ row, questionId: questionIdOf(row.article_url), answerId: answerIdOf(row.article_url) }))
      .filter((item) => item.answerId && !bankTitleByQuestionId.has(item.questionId ?? ""));
    const zhihuTitleByAnswerId = new Map<string, string>();
    for (let i = 0; i < needZhihu.length; i += BATCH) {
      const chunk = needZhihu.slice(i, i + BATCH);
      const results = await Promise.all(chunk.map((item) => resolveOne(item.answerId!)));
      for (const item of results) {
        if (item.question_title) zhihuTitleByAnswerId.set(item.answer_id, item.question_title);
      }
    }

    // 专栏文章（zhuanlan.zhihu.com/p/…）走文章接口取标题
    const needArticle = titleTargets
      .map((row) => ({ row, articleId: articleIdOf(row.article_url) }))
      .filter((item) => item.articleId && !bankTitleByQuestionId.has(questionIdOf(item.row.article_url) ?? ""));
    const articleTitleById = new Map<string, string>();
    for (let i = 0; i < needArticle.length; i += BATCH) {
      const chunk = needArticle.slice(i, i + BATCH);
      const titles = await Promise.all(chunk.map((item) => resolveArticleTitle(item.articleId!)));
      chunk.forEach((item, index) => {
        if (titles[index]) articleTitleById.set(item.articleId!, titles[index]);
      });
    }

    let titlesFilled = 0;
    for (const row of titleTargets) {
      const questionId = questionIdOf(row.article_url);
      const title = (questionId && bankTitleByQuestionId.get(questionId))
        || zhihuTitleByAnswerId.get(answerIdOf(row.article_url) ?? "")
        || articleTitleById.get(articleIdOf(row.article_url) ?? "")
        || "";
      if (!title) continue;
      const { error } = await supabase.from(row.table).update({ article_title: title }).eq("id", row.id);
      if (!error) titlesFilled += 1;
    }

    // 标题改了也要重算一次（默认按题干生成的标题不改判定，但保持与投稿时一致）
    if (titlesFilled > 0) {
      const { data, error } = await supabase.rpc("keyflow_rescan_comprehensive_hits", { p_activity_id: null });
      if (!error && data) settled = data;
    }

    return json({
      ok: true,
      scanned: rows.length,
      pending: pending.length,
      resolved: resolvedById.size,
      updated,
      titles_filled: titlesFilled,
      skipped,
      duplicates,
      settled,
    });
  } catch (err) {
    return json({ ok: false, error: String(err) }, 500);
  }
});
