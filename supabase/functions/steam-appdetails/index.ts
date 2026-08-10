import { serve } from "https://deno.land/std@0.177.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function parseSteamReleaseDate(date: string): string | null {
  // 仅解析 Steam 英文含明确日期的格式
  const match = date.trim().match(/^(?:(\d{1,2})\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)|(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{1,2})),\s+(\d{4})$/);
  if (!match) return null;

  const [, dayFirst, monthFirst, monthLast, dayLast, yearText] = match;
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const year = Number(yearText);
  const month = months.indexOf(monthFirst || monthLast) + 1;
  const day = Number(dayFirst || dayLast);
  const parsed = new Date(Date.UTC(year, month - 1, day));

  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) return null;
  return `${yearText}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}T00:00:00+08:00`;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { appId } = await req.json();
    const value = String(appId || "");
    if (!/^\d{1,10}$/.test(value)) {
      return new Response(JSON.stringify({ success: false, error: "Invalid Steam App ID" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    let steamRes: Response;
    try {
      steamRes = await fetch(
        `https://store.steampowered.com/api/appdetails?appids=${value}&l=english&cc=cn`,
        { headers: { "User-Agent": "keyflow/1.0" }, signal: controller.signal },
      );
    } finally {
      clearTimeout(timeout);
    }

    if (!steamRes.ok) {
      return new Response(JSON.stringify({ success: false, error: `Steam API 请求失败（HTTP ${steamRes.status}）` }), {
        status: 502,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const contentType = steamRes.headers.get("content-type") || "";
    if (!contentType.includes("application/json")) {
      return new Response(JSON.stringify({ success: false, error: "Steam API 返回了非 JSON 响应" }), {
        status: 502,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    let payload;
    try {
      payload = await steamRes.json();
    } catch (e) {
      console.error("Failed to parse Steam API response", e);
      return new Response(JSON.stringify({ success: false, error: "Steam API 返回的 JSON 无法解析" }), {
        status: 502,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const game = payload?.[value]?.data;
    if (!payload?.[value]?.success || !game) {
      return new Response(JSON.stringify({ success: false, error: "Game not found" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const rd = game.release_date
    const releaseDate = rd?.date ? parseSteamReleaseDate(rd.date) : null

    return new Response(
      JSON.stringify({
        success: true,
        game: {
          appId: value,
          title: game.name || "",
          desc: game.short_description || "",
          cover: game.header_image || "",
          release_date: releaseDate,
          screenshots: (game.screenshots || []).slice(0, 4).map(s =>
            (s.path_full || s.path_thumbnail || "").replace(/\.1920x1080\.jpg/, ".600x338.jpg")
          ).filter(Boolean),
        },
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (e) {
    console.error("steam-appdetails failed", e);
    const message = e instanceof Error && e.name === "AbortError"
      ? "Steam API 请求超时，请稍后重试"
      : "Steam 元数据抓取失败，请稍后重试";
    return new Response(JSON.stringify({ success: false, error: message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
