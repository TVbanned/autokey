import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// 综合活动问题库：从腾讯文档表格拉取问题清单。
// 工作表 1：第 1 列 = 问题文本，第 2 列 = 问题 URL，第 3 列 = 权重（0-100），第 4 列 = 额外金币（回答该题额外发放的金币，0 或空表示没有）。
// 工作表 2：第 1 列 = 精华回答文本，第 2 列 = 回答 URL，第 3 列 = 答主名。
const TOKEN_URL = "https://docs.qq.com/oauth/v2/token";
const SHEET_API = "https://docs.qq.com/openapi/spreadsheet/v3";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const { activity_id } = await req.json();
    if (!activity_id) return json({ error: "缺少 activity_id" }, 400);

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const { data: act, error: actErr } = await supabase
      .from("keyflow_activities")
      .select("question_bank_url")
      .eq("id", activity_id)
      .maybeSingle();
    if (actErr) return json({ error: actErr.message }, 500);
    if (!act?.question_bank_url) return json({ error: "该活动未配置问题库链接" }, 400);

    const url = new URL(String(act.question_bank_url));
    const m = url.href.match(/docs\.qq\.com\/(?:sheet|doc)\/([A-Za-z0-9$]+)/);
    if (!m) return json({ error: "无法从链接识别腾讯文档表格 ID，请使用 docs.qq.com/sheet/... 链接" }, 400);
    const book = m[1];
    const tabSheet = url.searchParams.get("tab") || "";

    const { data: cfg } = await supabase
      .from("keyflow_tencent_docs_sync")
      .select("*")
      .eq("id", 1)
      .maybeSingle();
    if (!cfg) return json({ error: "腾讯文档同步配置不存在（keyflow_tencent_docs_sync）" }, 400);

    let accessToken = "";
    // 优先走 refresh_token 刷新；凭据缺失时回退使用现有 access_token
    if (cfg.refresh_token && cfg.client_secret && cfg.client_id) {
      try {
        const params = new URLSearchParams({
          client_id: String(cfg.client_id),
          client_secret: String(cfg.client_secret),
          grant_type: "refresh_token",
          refresh_token: String(cfg.refresh_token),
        });
        const tresp = await fetch(`${TOKEN_URL}?${params.toString()}`);
        const tok = await tresp.json();
        if (tresp.ok && tok.access_token) {
          accessToken = String(tok.access_token);
          await supabase
            .from("keyflow_tencent_docs_sync")
            .update({
              access_token: accessToken,
              refresh_token: tok.refresh_token ?? cfg.refresh_token,
              token_expires_at: new Date(Date.now() + Number(tok.expires_in ?? 7200) * 1000).toISOString(),
            })
            .eq("id", 1);
        }
      } catch (_) { /* 回退到现有 token */ }
    }
    if (!accessToken) {
      if (!cfg.access_token) {
        return json({ error: "腾讯文档授权缺失：既无可用的 access_token，也缺少 client_secret/refresh_token 用于刷新，请重新授权" }, 400);
      }
      accessToken = String(cfg.access_token);
    }

    const headers = {
      "Access-Token": accessToken,
      "Client-Id": String(cfg.client_id ?? ""),
      "Open-Id": String(cfg.open_id ?? ""),
    };

    // 获取工作表：URL tab 指定问题库时优先使用；第二张工作表用于精华回答。
    const sresp = await fetch(`${SHEET_API}/files/${encodeURIComponent(book)}?concise=1`, { headers });
    const sbody = await sresp.json().catch(() => ({}));
    const v3Code = sbody.code ?? (sbody.ret === 0 ? 0 : undefined);
    const sheets = sbody.properties ?? sbody.data?.properties ?? sbody.data?.sheets ?? [];
    const arr = Array.isArray(sheets) ? sheets : [];
    const sheetId = tabSheet || String(arr[0]?.sheetId ?? arr[0]?.sheetID ?? arr[0]?.sheet_id ?? arr[0]?.id ?? "");
    const featuredSheetId = String(arr[1]?.sheetId ?? arr[1]?.sheetID ?? arr[1]?.sheet_id ?? arr[1]?.id ?? "");
    if (!sresp.ok || !sheetId) {
      return json({ error: `获取工作表信息失败: HTTP ${sresp.status} code=${v3Code ?? sbody.ret} msg=${sbody.message ?? sbody.msg ?? ""}` }, 500);
    }

    const vresp = await fetch(`${SHEET_API}/files/${encodeURIComponent(book)}/${encodeURIComponent(sheetId)}/A1:D1000`, { headers });
    const vbody = await vresp.json().catch(() => ({}));
    if (!vresp.ok || (vbody.code != null && vbody.code !== 0) || (vbody.ret != null && vbody.ret !== 0)) {
      return json({ error: `读取表格数据失败: HTTP ${vresp.status} code=${vbody.code ?? vbody.ret} msg=${vbody.message ?? vbody.msg ?? ""}` }, 500);
    }
    const grid = vbody.gridData ?? vbody.data?.gridData ?? vbody.data?.result ?? {};
    const rows = grid.rows ?? [];

    const cellText = (cell: unknown) => {
      const value = (cell as { cellValue?: Record<string, unknown> } | null)?.cellValue;
      if (!value) return { text: "", url: "" };
      if (value.text != null) return { text: String(value.text).trim(), url: "" };
      if (value.link) {
        const link = value.link as { url?: unknown; text?: unknown };
        return { text: String(link.text ?? link.url ?? "").trim(), url: String(link.url ?? "").trim() };
      }
      if (value.number != null) return { text: String(value.number).trim(), url: "" };
      return { text: "", url: "" };
    };

    const extractQuestionId = (value: string) => {
      const matched = value.match(/https?:\/\/(?:www\.)?zhihu\.com\/(?:question|api\/v4\/questions)\/(\d+)(?:\/|$)/i);
      return matched?.[1] ?? null;
    };

    const questions: Record<string, unknown>[] = [];
    (Array.isArray(rows) ? rows : []).forEach((row: unknown, idx: number) => {
      const cells = Array.isArray((row as { values?: unknown[] })?.values) ? (row as { values: unknown[] }).values : [];
      const first = cellText(cells[0] ?? null);
      const second = cellText(cells[1] ?? null);
      const third = cellText(cells[2] ?? null);
      const fourth = cellText(cells[3] ?? null);
      const text = first.text;
      const url2 = second.url || second.text || first.url;
      const rawWeight = Number(third.text);
      const weight = Number.isFinite(rawWeight) && third.text !== "" ? Math.max(0, Math.min(100, rawWeight)) : 50;
      const rawReward = Number(fourth.text);
      const rewardCoins = Number.isFinite(rawReward) && fourth.text !== "" ? Math.max(0, Math.floor(rawReward)) : 0;
      // 支持标准表头；如果表格没有表头（第 1 行就是数据），也能正常读取。
      if (idx === 0 && /问题/.test(text) && /(URL|链接|url)/i.test(url2 || second.text)) return;
      if (!text && !url2) return;
      questions.push({ activity_id, question_text: text || `问题 ${idx + 1}`, question_url: url2, question_id: extractQuestionId(url2), weight, reward_coins: rewardCoins, position: idx });
    });

    const featuredAnswers: Record<string, unknown>[] = [];
    if (featuredSheetId) {
      const featuredResp = await fetch(`${SHEET_API}/files/${encodeURIComponent(book)}/${encodeURIComponent(featuredSheetId)}/A1:C1000`, { headers });
      const featuredBody = await featuredResp.json().catch(() => ({}));
      const featuredRows = featuredBody.gridData?.rows ?? featuredBody.data?.gridData?.rows ?? featuredBody.data?.result?.rows ?? [];
      (Array.isArray(featuredRows) ? featuredRows : []).forEach((row: unknown, idx: number) => {
        const cells = Array.isArray((row as { values?: unknown[] })?.values) ? (row as { values: unknown[] }).values : [];
        const first = cellText(cells[0] ?? null);
        const second = cellText(cells[1] ?? null);
        const third = cellText(cells[2] ?? null);
        const answererName = first.text;
        const answerText = second.text;
        const answerUrl = third.url || third.text || second.url;
        const isFeaturedHeader = idx === 0 && /答主名|回答文本|回答内容|链接|URL/i.test(`${answererName} ${answerText} ${third.text}`);
        if (isFeaturedHeader) return;
        if (!answererName && !answerText && !answerUrl) return;
        featuredAnswers.push({ activity_id, answer_text: answerText, answer_url: answerUrl, answerer_name: answererName, position: idx });
      });
    }

    // 先清空旧题目再写新数据：删除失败必须显式报错，
    // 否则会继续 insert 并报成难懂的 question_id 唯一键冲突（历史上踩过）。
    const { error: clearErr } = await supabase.from("keyflow_activity_questions").delete().eq("activity_id", activity_id);
    if (clearErr) return json({ error: `清空旧问题失败: ${clearErr.message}` }, 500);
    if (questions.length) {
      const { error: insErr } = await supabase.from("keyflow_activity_questions").insert(questions);
      if (insErr) return json({ error: `保存问题失败: ${insErr.message}` }, 500);
    }
    const { error: clearFeaturedErr } = await supabase.from("keyflow_activity_featured_answers").delete().eq("activity_id", activity_id);
    if (clearFeaturedErr) return json({ error: `清空旧精华回答失败: ${clearFeaturedErr.message}` }, 500);
    if (featuredAnswers.length) {
      const { error: featuredErr } = await supabase.from("keyflow_activity_featured_answers").insert(featuredAnswers);
      if (featuredErr) return json({ error: `保存精华回答失败: ${featuredErr.message}` }, 500);
    }

    return json({ success: true, count: questions.length, featured_count: featuredAnswers.length, sheet: sheetId, book });
  } catch (e) {
    return json({ error: e?.message ?? "未知错误" }, 500);
  }
});
