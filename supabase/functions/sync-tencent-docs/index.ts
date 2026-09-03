import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const TOKEN_URL = "https://docs.qq.com/oauth/v2/token";
const SHEET_API = "https://docs.qq.com/openapi/sheetbook/v2";
const TZ = "Asia/Shanghai";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const DELIVERY_STATUS: Record<string, string> = {
  pending: "待审",
  approved: "通过",
  revision_required: "需修改",
  rejected: "驳回",
};

// 日常问题&回答的表头（固定在第一行）
const DAILY_HEADER = ["创建时间", "标题", "知乎链接", "状态"];

// 每张表的列映射：返回一行单元格，顺序即腾讯文档表头顺序。
// ponytail: 只处理 INSERT（追加一行）；后续对记录的状态更新不会回写腾讯文档，
//           如需同步审核结果，需增加 record id -> 行号 的映射并支持 UPDATE 原地覆盖。
const COLUMNS: Record<string, (r: Record<string, unknown>, e: Record<string, unknown>) => (string | number)[]> = {
  keyflow_daily_submissions: (r, e) => [
    fmt(r.submitted_at),
    e.answerer_name ?? "",
    r.article_title ?? "",
    r.article_url ?? "",
    r.processed ? "已审" : "未审",
  ],
  keyflow_deliveries: (r, e) => [
    fmt(r.submitted_at),
    e.answerer_name ?? "",
    e.activity_title ?? "",
    r.article_title ?? "",
    r.article_url ?? "",
    r.claimed_word_count ?? "",
    r.verified_word_count ?? "",
    DELIVERY_STATUS[String(r.status)] ?? String(r.status ?? ""),
  ],
  keyflow_daily_questions: (r) => [
    fmt(r.created_at),
    r.title ?? "",
    r.zhihu_url ?? "",
    r.processed ? "已处理" : "未处理",
  ],
};

function fmt(v: unknown): string {
  if (v == null) return "";
  const d = new Date(String(v));
  if (isNaN(d.getTime())) return String(v);
  return d.toLocaleString("zh-CN", { timeZone: TZ, hour12: false });
}

// 从知乎链接末尾提取内容 ID（问题或回答），ID 越大表示发布越新。
function contentIdOf(url: unknown): number {
  const m = String(url ?? "").match(/(\d+)\/?$/);
  return m ? Number(m[1]) : 0;
}

function colLetter(n: number): string {
  let s = "";
  while (n > 0) {
    s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

async function enrich(
  supabase: ReturnType<typeof createClient>,
  table: string,
  record: Record<string, unknown>,
) {
  if (table === "keyflow_daily_submissions") {
    if (record.answerer_id) {
      const { data } = await supabase.from("keyflow_answerers").select("zhihu_name").eq("id", record.answerer_id).maybeSingle();
      return { answerer_name: data?.zhihu_name ?? "" };
    }
    return { answerer_name: "管理员" };
  }
  if (table === "keyflow_deliveries" && record.application_id) {
    const { data } = await supabase
      .from("keyflow_applications")
      .select("zhihu_name, keyflow_activities(title, game_name)")
      .eq("id", record.application_id)
      .maybeSingle();
    const act = data?.keyflow_activities;
    return {
      answerer_name: data?.zhihu_name ?? "",
      activity_title: act?.title || act?.game_name || "",
    };
  }
  return {};
}

async function refreshAccessToken(cfg: Record<string, unknown>) {
  const params = new URLSearchParams({
    client_id: String(cfg.client_id ?? ""),
    client_secret: String(cfg.client_secret ?? ""),
    grant_type: "refresh_token",
    refresh_token: String(cfg.refresh_token ?? ""),
  });
  const resp = await fetch(`${TOKEN_URL}?${params.toString()}`);
  const data = await resp.json();
  if (!resp.ok || !data.access_token) {
    throw new Error(`刷新腾讯文档 token 失败: ${data.error || data.msg || resp.status}`);
  }
  return data;
}

// 日常问题&回答：新增后全量重排，最新发布固定在表头下一行（第 2 行）。
// 因为 AFTER INSERT 触发器在整条 INSERT 语句提交后才发出 webhook，
// 所以同一批多行的所有 webhook 都会读到相同的已提交状态，重排结果幂等。
async function resortDailyQuestionsSheet(
  supabase: ReturnType<typeof createClient>,
  sheetKey: string,
  sheet: { book: string; sheet: string },
  token: string,
  cfg: { client_id: string; open_id: string },
): Promise<number> {
  // 回答已分流至 keyflow_daily_submissions（答主日常投稿），此表仅剩问题记录。
  const { data, error } = await supabase
    .from("keyflow_daily_questions")
    .select("id,title,zhihu_url,processed,created_at")
    .eq("content_type", "question");

  if (error) throw new Error(`读取日常问题记录失败: ${error.message}`);

  const list = (data ?? []).sort((a, b) =>
    (new Date(String(b.created_at)).getTime() - new Date(String(a.created_at)).getTime()) ||
    (contentIdOf(b.zhihu_url) - contentIdOf(a.zhihu_url)),
  );

  const values = [
    DAILY_HEADER,
    ...list.map((r) => [
      fmt(r.created_at),
      r.title ?? "",
      r.zhihu_url ?? "",
      r.processed ? "已处理" : "未处理",
    ]),
  ];

  const range = `${sheet.sheet}!A1:D${values.length}`;
  const resp = await fetch(`${SHEET_API}/${sheet.book}/values/${range}`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      "Access-Token": token,
      "Client-Id": cfg.client_id,
      "Open-Id": cfg.open_id,
    },
    body: JSON.stringify({ values }),
  });
  const body = await resp.json();
  if (body.ret !== 0) {
    throw new Error(`腾讯文档写入失败: ${body.msg || resp.status}`);
  }

  // 重建行号映射（最新在第二行，后续 UPDATE 据此原位更新状态列）
  if (list.length) {
    const payload = list.map((r, i) => ({
      table_name: sheetKey,
      record_id: String(r.id),
      row: 2 + i,
    }));
    const { error: upErr } = await supabase
      .from("keyflow_tencent_docs_rows")
      .upsert(payload, { onConflict: "table_name,record_id" });
    if (upErr) throw new Error(`重建行号映射失败: ${upErr.message}`);
  }

  return list.length;
}

// 全部活动投稿 / 答主日常投稿：新增后全量重排，最新提交固定在表头下一行（第 2 行）。
// 与日常问题&回答一致：AFTER INSERT 触发器在整条 INSERT 提交后才发 webhook，多行批量时重排幂等。
async function resortSubmissionsSheet(
  supabase: ReturnType<typeof createClient>,
  sheetKey: string,
  sheet: { book: string; sheet: string },
  token: string,
  cfg: { client_id: string; open_id: string },
): Promise<number> {
  let list: { id: string; submitted_at: unknown; cells: (string | number)[] }[] = [];

  if (sheetKey === "keyflow_deliveries") {
    const [dres, ares, tres] = await Promise.all([
      supabase.from("keyflow_deliveries").select("id,application_id,submitted_at,article_title,article_url,claimed_word_count,verified_word_count,status"),
      supabase.from("keyflow_applications").select("id,zhihu_name,activity_id"),
      supabase.from("keyflow_activities").select("id,title,game_name"),
    ]);
    if (dres.error) throw new Error(`读取活动投稿记录失败: ${dres.error.message}`);
    const appById: Record<string, any> = Object.fromEntries((ares.data ?? []).map((a) => [a.id, a]));
    const actById: Record<string, any> = Object.fromEntries((tres.data ?? []).map((a) => [a.id, a]));
    list = (dres.data ?? []).map((d) => {
      const app = appById[d.application_id] ?? {};
      const act = actById[app.activity_id] ?? {};
      return {
        id: String(d.id),
        submitted_at: d.submitted_at,
        cells: [
          fmt(d.submitted_at),
          app.zhihu_name ?? "",
          act.title || act.game_name || "",
          d.article_title ?? "",
          d.article_url ?? "",
          d.claimed_word_count ?? "",
          d.verified_word_count ?? "",
          DELIVERY_STATUS[String(d.status)] ?? String(d.status ?? ""),
        ],
      };
    });
  } else {
    const [sres, ares] = await Promise.all([
      supabase.from("keyflow_daily_submissions").select("id,answerer_id,submitted_at,article_title,article_url,processed"),
      supabase.from("keyflow_answerers").select("id,zhihu_name"),
    ]);
    if (sres.error) throw new Error(`读取日常投稿记录失败: ${sres.error.message}`);
    const answererById: Record<string, any> = Object.fromEntries((ares.data ?? []).map((a) => [a.id, a]));
    list = (sres.data ?? []).map((s) => ({
      id: String(s.id),
      submitted_at: s.submitted_at,
      cells: [
        fmt(s.submitted_at),
        s.answerer_id ? (answererById[s.answerer_id]?.zhihu_name ?? "") : "管理员",
        s.article_title ?? "",
        s.article_url ?? "",
        s.processed ? "已审" : "未审",
      ],
    }));
  }

  list.sort((a, b) =>
    new Date(String(b.submitted_at)).getTime() - new Date(String(a.submitted_at)).getTime()
  );

  if (!list.length) return 0;

  const colCount = list[0].cells.length;
  const range = `${sheet.sheet}!A2:${colLetter(colCount)}${1 + list.length}`;
  const resp = await fetch(`${SHEET_API}/${sheet.book}/values/${range}`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      "Access-Token": token,
      "Client-Id": cfg.client_id,
      "Open-Id": cfg.open_id,
    },
    body: JSON.stringify({ values: list.map((r) => r.cells) }),
  });
  const body = await resp.json();
  if (body.ret !== 0) {
    throw new Error(`腾讯文档写入失败: ${body.msg || resp.status}`);
  }

  // 重建行号映射（最新在第二行，后续 UPDATE 据此原位更新）
  const payload = list.map((r, i) => ({
    table_name: sheetKey,
    record_id: String(r.id),
    row: 2 + i,
  }));
  const { error: upErr } = await supabase
    .from("keyflow_tencent_docs_rows")
    .upsert(payload, { onConflict: "table_name,record_id" });
  if (upErr) throw new Error(`重建行号映射失败: ${upErr.message}`);

  return list.length;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const secret = Deno.env.get("SYNC_WEBHOOK_SECRET");
    if (secret && req.headers.get("authorization") !== `Bearer ${secret}`) {
      return json({ error: "unauthorized" }, 401);
    }

    const payload = await req.json();
    const table: string = payload.table;
    const record: Record<string, unknown> = payload.record;
    const op: string = payload.type;
    if ((op !== "INSERT" && op !== "UPDATE") || !COLUMNS[table] || !record) {
      return json({ ok: true, skipped: true });
    }

    // 回答已分流至答主日常投稿（keyflow_daily_submissions），日常问题&回答表不再写入回答，
    // 无需再按 content_type 路由子表，直接以表名作为 sheetKey。
    const sheetKey = table;

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const { data: cfg, error: cfgErr } = await supabase
      .from("keyflow_tencent_docs_sync")
      .select("*")
      .eq("id", 1)
      .single();
    if (cfgErr || !cfg) {
      return json({ error: "腾讯文档同步配置缺失，请先写入 keyflow_tencent_docs_sync 表" }, 500);
    }
    if (!cfg.client_id || !cfg.open_id) {
      return json({ error: "配置缺少 client_id 或 open_id" }, 500);
    }

    const sheet = cfg.sheets?.[sheetKey];
    if (!sheet?.book || !sheet?.sheet) {
      return json({ error: `表 ${sheetKey} 未配置腾讯文档 book/sheet` }, 500);
    }

    let token = cfg.access_token as string;
    const expiresAt = cfg.token_expires_at ? new Date(cfg.token_expires_at).getTime() : 0;
    if (!token || Date.now() >= expiresAt - 60_000) {
      const fresh = await refreshAccessToken(cfg);
      token = fresh.access_token;
      await supabase.from("keyflow_tencent_docs_sync").update({
        access_token: fresh.access_token,
        open_id: fresh.user_id || cfg.open_id,
        token_expires_at: new Date(Date.now() + (fresh.expires_in || 259200) * 1000).toISOString(),
      }).eq("id", 1);
    }

    // 日常问题&回答：新增时全量重排，最新发布置顶（表头固定第 1 行）。
    if (table === "keyflow_daily_questions" && op === "INSERT") {
      const count = await resortDailyQuestionsSheet(supabase, sheetKey, sheet, token, cfg);
      return json({ ok: true, table, op: "insert", reordered: count });
    }

    // 全部活动投稿 / 答主日常投稿：新增或状态更新时全量重排，最新提交置顶（表头固定第 1 行），
    // 避免单行原位更新与并发重排互相覆盖导致状态漏同步。
    if ((table === "keyflow_deliveries" || table === "keyflow_daily_submissions") && (op === "INSERT" || op === "UPDATE")) {
      const count = await resortSubmissionsSheet(supabase, sheetKey, sheet, token, cfg);
      return json({ ok: true, table, op: op === "INSERT" ? "insert" : "update", reordered: count });
    }

    const e = await enrich(supabase, table, record);
    const values = COLUMNS[table](record, e).map(String);

    // 确定写入行号：INSERT 用数据库原子分配行号（避免多行批量 INSERT 并发写同一行）；UPDATE 查映射表做原位更新。
    let row: number;
    if (op === "INSERT") {
      const { data: allocated, error: allocErr } = await supabase.rpc("keyflow_alloc_tencent_row", { p_table: sheetKey });
      if (allocErr || typeof allocated !== "number") {
        return json({ error: `分配腾讯文档行号失败: ${allocErr?.message ?? "无返回值"}` }, 500);
      }
      row = allocated;
    } else {
      const { data: m } = await supabase
        .from("keyflow_tencent_docs_rows")
        .select("row")
        .eq("table_name", sheetKey)
        .eq("record_id", String(record.id ?? ""))
        .maybeSingle();
      if (!m?.row) {
        // 兼容：INSERT 时行号未记上（如权限/时序问题），UPDATE 时用业务字段反查记录 id，
        // 在映射表里找“同表、该 id 已占用”的行，或退化为“同表已分配的最大行号”兜底。
        let recordId = String(record.id ?? "");
        if (!recordId && table === "keyflow_daily_questions" && record.zhihu_url) {
          const { data: q } = await supabase
            .from("keyflow_daily_questions")
            .select("id")
            .eq("zhihu_url", String(record.zhihu_url))
            .maybeSingle();
          if (q?.id) recordId = String(q.id);
        }
        if (recordId) {
          const { data: m2 } = await supabase
            .from("keyflow_tencent_docs_rows")
            .select("row")
            .eq("table_name", sheetKey)
            .eq("record_id", recordId)
            .maybeSingle();
          if (m2?.row) {
            row = Number(m2.row);
          } else {
            return json({ ok: true, skipped: true, reason: "no row mapping" });
          }
        } else {
          return json({ ok: true, skipped: true, reason: "no row mapping" });
        }
      } else {
        row = Number(m.row);
      }
    }

    const range = `${sheet.sheet}!A${row}:${colLetter(values.length)}${row}`;
    const resp = await fetch(`${SHEET_API}/${sheet.book}/values/${range}`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "Access-Token": token,
        "Client-Id": String(cfg.client_id),
        "Open-Id": String(cfg.open_id),
      },
      body: JSON.stringify({ values: [values] }),
    });
    const body = await resp.json();
    if (body.ret !== 0) {
      return json({ error: `腾讯文档写入失败: ${body.msg || resp.status}` }, 500);
    }

    if (op === "INSERT") {
      // 行号已由 keyflow_alloc_tencent_row 原子分配并推进游标，这里只记录映射。
      if (record.id) {
        await supabase.from("keyflow_tencent_docs_rows").upsert({
          table_name: sheetKey,
          record_id: String(record.id),
          row,
        });
      }
    }

    return json({ ok: true, table, row, op: op.toLowerCase() });
  } catch (err) {
    console.error("sync-tencent-docs failed", err);
    return json({ error: err instanceof Error ? err.message : "同步失败" }, 500);
  }
});

