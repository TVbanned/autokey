import { serve } from "https://deno.land/std@0.177.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

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

    const steamRes = await fetch(
      `https://store.steampowered.com/api/appdetails?appids=${value}&l=schinese&cc=cn`,
      { headers: { "User-Agent": "keyflow/1.0" } }
    );
    if (!steamRes.ok) {
      return new Response(JSON.stringify({ success: false, error: `Steam API error: ${steamRes.status}` }), {
        status: 502,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const payload = await steamRes.json();
    const game = payload?.[value]?.data;
    if (!payload?.[value]?.success || !game) {
      return new Response(JSON.stringify({ success: false, error: "Game not found" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(
      JSON.stringify({
        success: true,
        game: {
          appId: value,
          title: game.name || "",
          desc: game.short_description || "",
          cover: game.header_image || "",
          screenshots: (game.screenshots || []).slice(0, 4).map(s =>
            (s.path_full || s.path_thumbnail || "").replace(/\.1920x1080\.jpg/, ".600x338.jpg")
          ).filter(Boolean),
        },
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (e) {
    return new Response(JSON.stringify({ success: false, error: "Internal error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
