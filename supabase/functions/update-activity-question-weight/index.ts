import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const TOKEN_URL = "https://docs.qq.com/oauth/v2/token";
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
    const { question_id, weight } = await req.json();
    const nextWeight = Number(weight);
    if (!question_id || !Number.isInteger(nextWeight) || nextWeight < 0 || nextWeight > 100) return json({ error: "权重必须为 0 到 100 的整数" }, 400);

    const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const { data: question, error: questionError } = await supabase
      .from("keyflow_activity_questions")
      .select("id, activity_id, position")
      .eq("id", question_id)
      .single();
    if (questionError) return json({ error: questionError.message }, 500);

    const { data: activity, error: activityError } = await supabase
      .from("keyflow_activities")
      .select("question_bank_url")
      .eq("id", question.activity_id)
      .single();
    if (activityError || !activity?.question_bank_url) return json({ error: activityError?.message || "活动未配置问题库链接" }, 400);

    const sourceUrl = new URL(activity.question_bank_url);
    const book = sourceUrl.href.match(/docs\.qq\.com\/(?:sheet|doc)\/([A-Za-z0-9$]+)/)?.[1];
    const sheetId = sourceUrl.searchParams.get("tab");
    if (!book || !sheetId) return json({ error: "无法识别腾讯文档或工作表" }, 400);

    const { data: cfg } = await supabase.from("keyflow_tencent_docs_sync").select("*").eq("id", 1).single();
    if (!cfg?.access_token) return json({ error: "腾讯文档授权失效，请重新授权后再试" }, 400);
    let accessToken = String(cfg.access_token);
    if (cfg.refresh_token && cfg.client_secret && cfg.client_id) {
      const params = new URLSearchParams({ client_id: String(cfg.client_id), client_secret: String(cfg.client_secret), grant_type: "refresh_token", refresh_token: String(cfg.refresh_token) });
      const tokenResponse = await fetch(`${TOKEN_URL}?${params}`);
      const token = await tokenResponse.json().catch(() => ({}));
      if (tokenResponse.ok && token.access_token) {
        accessToken = String(token.access_token);
        await supabase.from("keyflow_tencent_docs_sync").update({ access_token: accessToken, refresh_token: token.refresh_token ?? cfg.refresh_token, token_expires_at: new Date(Date.now() + Number(token.expires_in ?? 7200) * 1000).toISOString() }).eq("id", 1);
      }
    }
    const headers = { "Access-Token": accessToken, "Client-Id": String(cfg.client_id ?? ""), "Open-Id": String(cfg.open_id ?? ""), "Content-Type": "application/json" };
    const updateResponse = await fetch(`${SHEET_API}/files/${encodeURIComponent(book)}/batchUpdate`, {
      method: "POST",
      headers,
      body: JSON.stringify({ requests: [{ updateRangeRequest: { sheetId, gridData: { startRow: Number(question.position), startColumn: 2, rows: [{ values: [{ cellValue: { number: nextWeight } }] }] } } }] }),
    });
    const updateBody = await updateResponse.json().catch(() => ({}));
    if (!updateResponse.ok || (updateBody.code != null && updateBody.code !== 0)) return json({ error: `腾讯文档写入失败: ${updateBody.message ?? updateBody.msg ?? `HTTP ${updateResponse.status}`}` }, 502);

    const { error: saveError } = await supabase.from("keyflow_activity_questions").update({ weight: nextWeight }).eq("id", question_id);
    if (saveError) return json({ error: saveError.message }, 500);
    return json({ success: true, weight: nextWeight });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "更新权重失败" }, 500);
  }
});
