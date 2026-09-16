import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// 读取「答主信息」腾讯文档工作表1 的 K 列（知乎id / 用户 member_id），按答主 ID + 知乎名返回映射。
// 用途：积分商城「报销订单 → 导出补发 csv」需要把 order.answerer_id 换成知乎的 member_id。
const SHEET_API = "https://docs.qq.com/openapi/spreadsheet/v3";
const TOKEN_URL = "https://docs.qq.com/oauth/v2/token";
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

type Row = { values?: Array<{ cellValue?: { text?: string; number?: number; link?: { text?: string; url?: string } } }> };

const cellText = (cell: Row["values"] extends (infer T)[] | undefined ? T | undefined : never): string => {
  const value = cell?.cellValue;
  if (!value) return "";
  if (value.text != null) return String(value.text).trim();
  if (value.link) return String(value.link.text ?? value.link.url ?? "").trim();
  if (value.number != null) return String(value.number).trim();
  return "";
};

async function refreshToken(cfg: Record<string, unknown>) {
  if (!cfg.refresh_token || !cfg.client_secret || !cfg.client_id) return "";
  const params = new URLSearchParams({
    client_id: String(cfg.client_id),
    client_secret: String(cfg.client_secret),
    grant_type: "refresh_token",
    refresh_token: String(cfg.refresh_token),
  });
  const res = await fetch(`${TOKEN_URL}?${params.toString()}`);
  if (!res.ok) return "";
  const body = await res.json().catch(() => ({}));
  return String(body?.access_token ?? "");
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const body = await req.json().catch(() => ({}));
    const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

    const { data: isAdmin, error: adminError } = await supabase.rpc("keyflow_is_admin", { p_token: String(body?.adminToken ?? "") });
    if (adminError || !isAdmin) return json({ error: "无权操作" }, 401);

    const { data: cfg, error: configError } = await supabase
      .from("keyflow_tencent_docs_sync")
      .select("client_id,open_id,access_token,refresh_token,client_secret,sheets")
      .eq("id", 1)
      .single();
    if (configError || !cfg) throw new Error(`读取同步配置失败: ${configError?.message ?? "配置不存在"}`);

    const sheetCfg = body?.book && body?.sheet
      ? { book: String(body.book), sheet: String(body.sheet) }
      : cfg.sheets?.keyflow_answerers;
    if (!cfg.client_id || !cfg.open_id || !sheetCfg?.book || !sheetCfg?.sheet) throw new Error("腾讯文档同步配置不完整");

    const readSheet = async (accessToken: string) => {
      const res = await fetch(`${SHEET_API}/files/${encodeURIComponent(sheetCfg.book)}/${encodeURIComponent(sheetCfg.sheet)}/A1:K500`, {
        headers: {
          "Access-Token": accessToken,
          "Client-Id": String(cfg.client_id),
          "Open-Id": String(cfg.open_id),
          "Content-Type": "application/json",
        },
      });
      const text = await res.text();
      let payload: Record<string, unknown> = {};
      try { payload = JSON.parse(text); } catch { /* 非 JSON */ }
      return { ok: res.ok, status: res.status, payload, text };
    };

    let token = String(cfg.access_token ?? "");
    let read = await readSheet(token);
    const failed = !read.ok || !(read.payload.gridData || (read.payload.data as Record<string, unknown> | undefined)?.gridData);
    if (failed) {
      const fresh = await refreshToken(cfg);
      if (fresh) {
        token = fresh;
        read = await readSheet(token);
      }
    }

    const data = read.payload as {
      gridData?: { rows?: Row[] };
      data?: { gridData?: { rows?: Row[] }; result?: { rows?: Row[] } };
    };
    const rows: Row[] = data.gridData?.rows ?? data.data?.gridData?.rows ?? data.data?.result?.rows ?? [];
    if (!Array.isArray(rows) || !rows.length) {
      return json({ success: false, error: `读取表格失败：HTTP ${read.status} ${read.text.slice(0, 160)}` }, 502);
    }

    const byId: Record<string, string> = {};
    const byName: Record<string, string> = {};
    for (let i = 1; i < rows.length; i++) {
      const cells = rows[i]?.values ?? [];
      const answererId = cellText(cells[0]);
      const name = cellText(cells[2]);
      const memberId = cellText(cells[10]); // K 列
      if (!memberId) continue;
      if (answererId) byId[answererId] = memberId;
      if (name && !byName[name]) byName[name] = memberId;
    }

    return json({
      success: true,
      book: sheetCfg.book,
      sheet: sheetCfg.sheet,
      rowCount: rows.length - 1,
      mappedCount: Object.keys(byId).length,
      byId,
      byName,
    });
  } catch (e) {
    console.error("answerer-member-ids failed", e);
    return json({ success: false, error: e instanceof Error ? e.message : "读取 member_id 失败" }, 500);
  }
});
