import { serve } from "https://deno.land/std@0.177.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Content-Type": "application/json; charset=utf-8",
};

const MAX_ITEMS = 20;

type Item = { id: string | number; title: string };
type AiResult = { index?: number; title?: string; description?: string };

function json(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" },
  });
}

function cleanJsonContent(content: string) {
  return String(content || "{}").replace(/^```(?:json)?\s*|\s*```$/g, "").trim();
}

async function deepseekChat(messages: Array<{ role: string; content: string }>, temperature: number) {
  const apiKey = Deno.env.get("DEEPSEEK_API_KEY");
  const baseUrl = Deno.env.get("DEEPSEEK_BASE_URL") || "https://api.deepseek.com/v1";
  if (!apiKey) throw new Error("AI 服务尚未配置密钥，请联系管理员。");
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "deepseek-v4-flash",
      temperature,
      max_tokens: 4000,
      response_format: { type: "json_object" },
      messages,
    }),
    signal: AbortSignal.timeout(45_000),
  });
  if (!response.ok) throw new Error(`AI 服务请求失败（HTTP ${response.status}）`);
  const payload = await response.json();
  return String(payload.choices?.[0]?.message?.content || "");
}

async function chatOnce(system: string, user: string, temperature: number) {
  try {
    return await deepseekChat([
      { role: "system", content: system },
      { role: "user", content: user },
    ], temperature);
  } catch {
    return await deepseekChat([
      { role: "system", content: system + " 上次输出不是合法 JSON。请只输出一个合法的 JSON 对象，字符串内的引号必须用 \\\" 转义，换行用 \\n。不要输出任何其他文字。" },
      { role: "user", content: user },
    ], temperature);
  }
}

function extractResults(content: string): AiResult[] {
  const cleaned = cleanJsonContent(content);
  for (const attempt of [cleaned, cleaned.replace(/[\r\n]+/g, " ")]) {
    try {
      const parsed = JSON.parse(attempt);
      const list = Array.isArray(parsed) ? parsed : parsed?.results;
      if (Array.isArray(list)) return list;
    } catch {
      // try next
    }
  }
  // 兜底：从残缺 JSON 中逐个提取 index 与 title/description
  const results: AiResult[] = [];
  const pattern = /"index"\s*:\s*(\d+)[\s\S]*?"(?:title|description)"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(cleaned)) !== null) {
    results.push({ index: Number(match[1]), title: match[2], description: match[2] });
  }
  return results;
}

function truncateChars(text: string, max: number, tail = "") {
  const chars = [...text];
  if (chars.length <= max) return text;
  return chars.slice(0, max).join("").replace(/[，。；、\s]+$/, "") + tail;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ success: false, error: "Method not allowed" }, 405);

  let body: { action?: string; texts?: unknown };
  try {
    body = await req.json();
  } catch {
    return json({ success: false, error: "请求体不是有效的 JSON" }, 400);
  }

  const { action, texts } = body;
  if (action !== "shorten" && action !== "describe" && action !== "describe-raw" && action !== "ask") return json({ success: false, error: "不支持的 action" }, 400);
  if (!Array.isArray(texts) || texts.length === 0) return json({ success: false, error: "缺少问题文本" }, 400);
  if (texts.length > MAX_ITEMS) return json({ success: false, error: `单次最多处理 ${MAX_ITEMS} 条` }, 400);

  const items: Item[] = texts
    .filter((item): item is Item => !!item && typeof item === "object" && (typeof item.id === "string" || typeof item.id === "number") && typeof item.title === "string")
    .map((item) => ({ id: item.id, title: item.title.trim() }))
    .filter((item) => item.title);
  if (!items.length) return json({ success: false, error: "没有有效的问题文本" }, 400);

  try {
    const payload = items.map((item, index) => ({ index, title: item.title }));
    if (action === "shorten") {
      const system = "你是知乎运营助手。把用户给出的每个过长问题标题压缩改写为不超过 50 个字符的标题：保留核心信息与疑问语气，语言自然口语化，不添加原文没有的信息，不要写任何解释。只返回 JSON 对象，格式为 {\"results\":[{\"index\":0,\"title\":\"...\"}]}。";
      const user = JSON.stringify(payload) + " 注意：必须输出合法 JSON，字符串内的引号和换行必须转义。";
      const content = await chatOnce(system, user, 0.3);
      const results = extractResults(content);
      const byIndex = new Map(results.map((item) => [item?.index, item?.title]));
      let failed = 0;
      const mapped = items.map((item, index) => {
        const title = byIndex.get(index);
        if (typeof title === "string" && title) return { id: item.id, title: truncateChars(title, 50) };
        failed += 1;
        return { id: item.id, title: item.title };
      });
      return json({
        success: true,
        warning: failed ? `有 ${failed} 条缩题未成功，可再次点击重试` : undefined,
        results: mapped,
      });
    }

    if (action === "ask") {
      const system = "你是知乎运营助手。把用户给出的内容标题改写成知乎提问标题：保留核心信息与疑问语气，口语自然，结尾用问号，不超过 50 个字符；不要添加原文没有的信息，不要写任何解释。只返回 JSON 对象，格式为 {\"results\":[{\"index\":0,\"title\":\"...\"}]}。";
      const user = JSON.stringify(payload) + " 注意：必须输出合法 JSON，字符串内的引号和换行必须转义。";
      const content = await chatOnce(system, user, 0.3);
      const results = extractResults(content);
      const byIndex = new Map(results.map((item) => [item?.index, item?.title]));
      let failed = 0;
      const mapped = items.map((item, index) => {
        const title = byIndex.get(index);
        if (typeof title === "string" && title) return { id: item.id, title: truncateChars(title, 50) };
        failed += 1;
        return { id: item.id, title: "" };
      });
      return json({
        success: true,
        warning: failed ? `有 ${failed} 条转提问未成功，可再次点击重试` : undefined,
        results: mapped,
      });
    }
    const system = action === "describe-raw"
      ? "你是知乎游戏话题运营，擅长把问题标题扩写成 40–100 字的问题描述。要求：越随意越好，像真实网友在评论区聊天讨论，别太工整，允许口语化的错别字、语气词、省略号，允许换行分段（输出时换行用 \\n 转义）；始终围绕标题这一个问题展开，结尾最多一个自然反问，不要把多个提问塞进同一段描述；不要使用任何引号（包括单引号和双引号）；不要编造具体事实；描述结尾不要使用句号，尽量少用感叹号。只返回 JSON 对象，格式为 {\"results\":[{\"index\":0,\"description\":\"...\"}]}。"
      : "你是知乎游戏话题运营，擅长把问题标题扩写成 60–100 字的问题描述。要求：口语化、像真实玩家聊天，可以用代入感强的开头或简短背景，加一点个人看法或好奇点；多用短句，简洁不啰嗦，避免书面腔、营销腔和空话；提到游戏或产品时用玩家常说的简称或口语说法，不要照抄完整官方名（例如 RE:BOOT 就说成 RE版本）；不偏离标题主题，不编造具体事实；描述结尾不要使用句号，尽量少用感叹号。只返回 JSON 对象，格式为 {\"results\":[{\"index\":0,\"description\":\"...\"}]}。";
    const user = JSON.stringify(payload) + " 注意：必须输出合法 JSON，字符串内的引号和换行必须转义。";
    const content = await chatOnce(system, user, 0.7);
    const results = extractResults(content);
    const byIndex = new Map(results.map((item) => [item?.index, item?.description]));
    let failed = 0;
    const mapped = items.map((item, index) => {
      const description = byIndex.get(index);
      if (typeof description === "string" && description) return { id: item.id, description: truncateChars(description, 150, "……").replace(/[。]+$/, "") };
      failed += 1;
      return { id: item.id, description: "" };
    });
    return json({
      success: true,
      warning: failed ? `有 ${failed} 条描述未生成成功，可再次点击重试` : undefined,
      results: mapped,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "AI 处理失败，请稍后重试";
    return json({ success: false, error: message }, 502);
  }
});
