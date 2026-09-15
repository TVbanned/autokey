import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SHEET_API = "https://docs.qq.com/openapi/spreadsheet/v3";
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const { adminToken } = await req.json();
    const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const { data: isAdmin, error: adminError } = await supabase.rpc("keyflow_is_admin", { p_token: String(adminToken ?? "") });
    if (adminError || !isAdmin) return json({ error: "无权操作" }, 401);

    const [{ data: cfg, error: configError }, { data: answerers, error: answererError }] = await Promise.all([
      supabase.from("keyflow_tencent_docs_sync").select("client_id,open_id,access_token,sheets").eq("id", 1).single(),
      supabase.from("keyflow_answerers").select("id,serial_number,zhihu_name,remark,account_address,wechat_id,avatar_url,created_at,updated_at").order("created_at", { ascending: true }),
    ]);
    if (configError || !cfg) throw new Error(`读取同步配置失败: ${configError?.message ?? "配置不存在"}`);
    if (answererError) throw new Error(`读取答主信息失败: ${answererError.message}`);
    const sheet = cfg.sheets?.keyflow_answerers;
    if (!cfg.access_token || !cfg.client_id || !cfg.open_id || !sheet?.book || !sheet?.sheet) throw new Error("腾讯文档同步配置不完整");

    const formatTime = (value: string | null) => value
      ? new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", dateStyle: "short", timeStyle: "medium" }).format(new Date(value))
      : "";
    const extractZhihuToken = (address: string | null) => {
      if (!address) return "";
      try {
        const matched = new URL(address).pathname.match(/^\/people\/([^/?#]+)/i);
        return matched?.[1] ? decodeURIComponent(matched[1]) : "";
      } catch {
        return "";
      }
    };
    const values = [
      ["答主 ID", "注册编号", "知乎用户名", "备注", "知乎主页地址", "微信号", "头像地址", "注册时间", "更新时间", "知乎 token"],
      ...(answerers ?? []).map((answerer) => [
        answerer.id ?? "",
        answerer.serial_number == null ? "" : String(answerer.serial_number).padStart(3, "0"),
        answerer.zhihu_name ?? "",
        answerer.remark ?? "",
        answerer.account_address ?? "",
        answerer.wechat_id ?? "",
        answerer.avatar_url ?? "",
        formatTime(answerer.created_at),
        formatTime(answerer.updated_at),
        extractZhihuToken(answerer.account_address),
      ]),
    ];
    const headers = { "Content-Type": "application/json", "Access-Token": cfg.access_token, "Client-Id": cfg.client_id, "Open-Id": cfg.open_id };
    const response = await fetch(`${SHEET_API}/files/${encodeURIComponent(sheet.book)}/batchUpdate`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        requests: [{
          updateRangeRequest: {
            sheetId: sheet.sheet,
            gridData: {
              startRow: 0,
              startColumn: 0,
              rows: values.map((row) => ({ values: row.map((cell) => ({ cellValue: { text: String(cell) } })) })),
            },
          },
        }],
      }),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || (result.code != null && result.code !== 0) || (result.ret != null && result.ret !== 0)) {
      throw new Error(`腾讯文档写入失败: ${result.message ?? result.msg ?? response.status}`);
    }

    const verification = await fetch(`${SHEET_API}/files/${encodeURIComponent(sheet.book)}/${encodeURIComponent(sheet.sheet)}/A1:A2`, { headers });
    const verificationResult = await verification.json().catch(() => ({}));
    const verificationGrid = verificationResult?.gridData ?? verificationResult?.data?.gridData ?? verificationResult?.data?.result ?? {};
    const verificationRows = Array.isArray(verificationGrid.rows) ? verificationGrid.rows : [];
    const verifiedHeader = verificationRows[0]?.values?.[0]?.cellValue?.text;
    const verifiedFirstAnswerer = verificationRows[1]?.values?.[0]?.cellValue?.text;
    if (!verification.ok || verifiedHeader !== "答主 ID" || ((answerers?.length ?? 0) > 0 && !verifiedFirstAnswerer)) {
      throw new Error(`腾讯文档写入后校验失败: HTTP ${verification.status}, 表头=${String(verifiedHeader ?? "空")}`);
    }

    return json({ ok: true, count: answerers?.length ?? 0 });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "同步失败" }, 500);
  }
});
