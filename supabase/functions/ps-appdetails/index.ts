import { serve } from "https://deno.land/std@0.177.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

interface PSGame {
  title: string;
  desc: string;
  cover: string;
  release_date: string | null;
  publisher: string;
  genre: string;
  screenshots: string[];
}

function extractMeta(html: string, name: string): string {
  const patterns = [
    new RegExp(`<meta\\s+name=["']${name}["']\\s+content=["']([^"']+)["']`, "i"),
    new RegExp(`<meta\\s+content=["']([^"']+)["']\\s+name=["']${name}["']`, "i"),
    new RegExp(`<meta\\s+property=["']og:${name}["']\\s+content=["']([^"']+)["']`, "i"),
    new RegExp(`<meta\\s+content=["']([^"']+)["']\\s+property=["']og:${name}["']`, "i"),
  ];
  for (const p of patterns) {
    const m = html.match(p);
    if (m) return m[1];
  }
  return "";
}

function extractTitle(html: string): string {
  const og = extractMeta(html, "title");
  if (og) {
    return og
      .replace(/\s*[-–|]\s*游戏\s*\|\s*PlayStation.*$/i, "")
      .replace(/\s*[-–|]\s*PlayStation.*$/i, "")
      .replace(/\s*\([^)]*\)\s*$/, "") // Remove trailing language parens
      .trim();
  }
  const titleMatch = html.match(/<title>([^<]+)<\/title>/i);
  return titleMatch ? titleMatch[1].replace(/\s*[-–|]\s*PlayStation.*$/i, "").trim() : "";
}

function extractPreloadImage(html: string): string {
  const match = html.match(
    /<link\s+rel=["']preload["'][^>]*href=["']([^"']*(?:hero|keyart|game-hub)[^"']*)["'][^>]*>/i,
  );
  if (match) {
    return match[1].replace(/\?\$\d+px\$/, "?$1200px$");
  }
  const imgMatch = html.match(/https:\/\/gmedia\.playstation\.com\/is\/image\/[^"'\s]+/i);
  return imgMatch ? imgMatch[0].replace(/\?\$\d+px\$/, "?$1200px$") : "";
}

/**
 * Simple string-based extraction of game data from embedded JSON in the HTML.
 * PlayStation pages embed Apollo cache data as a JSON blob with Product, Concept, etc.
 */
function extractGameDataFromHTML(html: string): Partial<PSGame> {
  const result: Partial<PSGame> = {};

  // Genre: find "localizedGenres":[{...,"value":"动作"}]
  const genreMatch = html.match(/"localizedGenres"\s*:\s*\[\s*\{[^}]*"value"\s*:\s*"([^"]+)"/);
  if (genreMatch) result.genre = genreMatch[1];

  // Cover: find GAMEHUB_COVER_ART IMAGE url
  const coverMatch = html.match(
    /"role"\s*:\s*"GAMEHUB_COVER_ART"\s*,\s*"type"\s*:\s*"IMAGE"[^}]*"url"\s*:\s*"([^"]+)"/
  );
  if (coverMatch) result.cover = coverMatch[1];
  // Fallback: MASTER image
  if (!result.cover) {
    const masterMatch = html.match(
      /"role"\s*:\s*"MASTER"\s*,\s*"type"\s*:\s*"IMAGE"[^}]*"url"\s*:\s*"([^"]+)"/
    );
    if (masterMatch) result.cover = masterMatch[1];
  }

  // Screenshots: find all SCREENSHOT IMAGE urls (take first 4)
  const screenshotRegex = /"role"\s*:\s*"SCREENSHOT"\s*,\s*"type"\s*:\s*"IMAGE"[^}]*"url"\s*:\s*"([^"]+)"/g;
  const screenshots: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = screenshotRegex.exec(html)) !== null && screenshots.length < 4) {
    if (!screenshots.includes(m[1])) screenshots.push(m[1]);
  }
  if (screenshots.length > 0) result.screenshots = screenshots;

  // Name: find "storeDisplayClassification":"FULL_GAME" and backtrack to get "name":"..."
  const gameNameMatch = html.match(
    /"storeDisplayClassification"\s*:\s*"FULL_GAME"[\s\S]{0,200}"name"\s*:\s*"([^"]+)"/m
  );
  if (gameNameMatch) {
    result.title = gameNameMatch[1]
      .replace(/\s*\([^)]*\)\s*$/, "")
      .trim();
  }
  // Fallback: any "name" near localizedGenres
  if (!result.title) {
    const nameMatch = html.match(/"localizedGenres"[\s\S]{0,300}"name"\s*:\s*"([^"]+)"/m);
    if (nameMatch) {
      result.title = nameMatch[1]
        .replace(/\s*\([^)]*\)\s*$/, "")
        .replace(/^《|》$/g, "")
        .trim();
    }
  }

  // Release date & Publisher from Concept object
   // Concept objects can be large due to nested descriptions, so search the whole HTML
   const conceptKeyMatch = html.match(/"Concept:\d+":\{/i);
   if (conceptKeyMatch) {
     // Search up to 15000 chars after the Concept key for publisherName and releaseDate
     const pos = conceptKeyMatch.index!;
     const section = html.substring(pos, pos + 15000);
     const pubMatch = section.match(/"publisherName"\s*:\s*"([^"]+)"/);
     if (pubMatch) result.publisher = pubMatch[1];
     const dateMatch = section.match(/"releaseDate"\s*:\s*"([^"]+)"/);
     if (dateMatch) result.release_date = dateMatch[1];
   }

  return result;
}

function extractFromBody(html: string, label: string): string {
  const htmlNoTags = html.replace(/<[^>]+>/g, "\n");
  const lines = htmlNoTags.split("\n").map((s) => s.trim()).filter(Boolean);

  const labelPatterns: Record<string, RegExp[]> = {
    release_date: [/发售日期/i, /發售日期/i, /Release\s*date/i],
    publisher: [/发行商/i, /發行商/i, /Publisher/i],
    genre: [/游戏类型/i, /遊戲類型/i, /Genre/i],
  };

  const ps = labelPatterns[label];
  if (!ps) return "";

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const lp of ps) {
      if (lp.test(line)) {
        const sameLineMatch = line.match(/[：:]\s*(.+)/);
        if (sameLineMatch) {
          const val = sameLineMatch[1].trim();
          if (val && !/^[\s:：]*$/.test(val)) return val;
        }
        for (let j = i + 1; j < Math.min(i + 4, lines.length); j++) {
          const nextLine = lines[j].trim();
          if (nextLine && !/^(平台|发售|發售|发行|發行|游戏|遊戲|语音|屏幕|PS\d)/.test(nextLine)) {
            return nextLine;
          }
        }
      }
    }
  }
  return "";
}

function parsePSReleaseDate(date: string): string | null {
  const trimmed = date.trim();
  if (!trimmed) return null;

  // ISO: "2025-10-01" or "2025-10-01T00:00:00Z"
  const isoMatch = trimmed.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (isoMatch) {
    return `${isoMatch[1]}-${String(Number(isoMatch[2])).padStart(2, "0")}-${String(Number(isoMatch[3])).padStart(2, "0")}T00:00:00+08:00`;
  }

  // DD/MM/YYYY: "1/10/2025"
  const slashMatch = trimmed.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (slashMatch) {
    const day = Number(slashMatch[1]);
    const month = Number(slashMatch[2]);
    const year = Number(slashMatch[3]);
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}T00:00:00+08:00`;
  }

  // Chinese: "2025 年 10 月 1 日"
  const chMatch = trimmed.match(/^(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日$/);
  if (chMatch) {
    return `${chMatch[1]}-${String(Number(chMatch[2])).padStart(2, "0")}-${String(Number(chMatch[3])).padStart(2, "0")}T00:00:00+08:00`;
  }

  return null;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { url } = await req.json();
    const rawUrl = String(url || "").trim();
    if (!rawUrl) {
      return new Response(
        JSON.stringify({ success: false, error: "请输入 PlayStation 游戏页面地址" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    let parsedUrl: URL;
    try {
      parsedUrl = new URL(rawUrl);
    } catch {
      return new Response(
        JSON.stringify({ success: false, error: "无法解析该地址" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    if (!parsedUrl.hostname.endsWith("playstation.com")) {
      return new Response(
        JSON.stringify({ success: false, error: "请输入 playstation.com 的游戏页面地址" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    if (!/\/games\/[^/]+/.test(parsedUrl.pathname)) {
      return new Response(
        JSON.stringify({ success: false, error: "URL 格式应为 playstation.com/.../games/游戏名/" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // Fetch the page
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    let psRes: Response;
    try {
      psRes = await fetch(rawUrl, {
        headers: { "User-Agent": "keyflow/1.0", "Accept-Language": "zh-Hans,zh;q=0.9" },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }

    if (!psRes.ok) {
      return new Response(
        JSON.stringify({ success: false, error: `PlayStation 页面请求失败（HTTP ${psRes.status}）` }),
        { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // Read as arrayBuffer first to handle encoding properly
    const buffer = await psRes.arrayBuffer();
    const decoder = new TextDecoder("utf-8");
    const html = decoder.decode(buffer);

    // Extract game data from embedded JSON and meta tags
    const gameData = extractGameDataFromHTML(html);
    const metaTitle = extractTitle(html);
    const desc = extractMeta(html, "description");
    const coverFallback = extractPreloadImage(html);

    // Fallback: HTML body extraction for fields not in Apollo state
    const rawReleaseDate = extractFromBody(html, "release_date");
    const releaseDateFallback = parsePSReleaseDate(rawReleaseDate);
    const publisherFallback = extractFromBody(html, "publisher");
    const genreFallback = extractFromBody(html, "genre");

    // Merge: Apollo data takes priority, fallback to HTML meta/body extraction
    const title = gameData.title || metaTitle;
    const cover = gameData.cover || coverFallback;
    const releaseDate = gameData.release_date
      ? parsePSReleaseDate(gameData.release_date)
      : releaseDateFallback;
    const publisher = gameData.publisher || publisherFallback;
    const genre = gameData.genre || genreFallback;
    const screenshots = gameData.screenshots || [];

    if (!title) {
      return new Response(
        JSON.stringify({ success: false, error: "未能从页面提取游戏信息，请确认 URL 是否正确" }),
        { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const game: PSGame = {
      title,
      desc,
      cover,
      release_date: releaseDate,
      publisher,
      genre,
      screenshots,
    };

    return new Response(JSON.stringify({ success: true, game }), {
      headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" },
    });
  } catch (e) {
    console.error("ps-appdetails failed", e);
    const message =
      e instanceof Error && e.name === "AbortError"
        ? "PlayStation 页面请求超时，请稍后重试"
        : "PlayStation 元数据抓取失败，请稍后重试";
    return new Response(JSON.stringify({ success: false, error: message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
