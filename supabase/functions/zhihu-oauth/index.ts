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
    const { code, redirect_uri } = await req.json();
    if (!code || !redirect_uri) {
      return new Response(JSON.stringify({ success: false, error: "缺少 code 或 redirect_uri" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const app_id = Deno.env.get("ZHIHU_APP_ID");
    const app_key = Deno.env.get("ZHIHU_APP_KEY");
    if (!app_id || !app_key) {
      return new Response(JSON.stringify({ success: false, error: "知乎 OAuth 凭证未配置" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Step 1: 授权码换 access_token
    const tokenRes = await fetch("https://openapi.zhihu.com/access_token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        app_id,
        app_key,
        grant_type: "authorization_code",
        redirect_uri,
        code,
      }),
    });

    if (!tokenRes.ok) {
      return new Response(JSON.stringify({ success: false, error: `Token 交换失败: ${tokenRes.status}` }), {
        status: 502,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const tokenData = await tokenRes.json();

    // ponytail: 知乎业务字段 code:20000=成功，但 tokenData 可能不包含 code 字段
    // 优先检查 access_token 是否存在
    if (!tokenData.access_token) {
      return new Response(JSON.stringify({ success: false, error: "未返回 access_token", raw: tokenData }), {
        status: 502,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Step 2: 尝试获取用户信息（/user 端点 2077 项目实测可用，但 schema 未公开）
    let user = null;
    try {
      const userRes = await fetch(
        `https://openapi.zhihu.com/user?access_token=${encodeURIComponent(tokenData.access_token)}`,
        { headers: { "Authorization": `Bearer ${tokenData.access_token}` } },
      );
      if (userRes.ok) {
        const userData = await userRes.json();
        // code:20000 或直接包含 id 字段视为成功
        if (userData.code === 20000 || userData.id || userData.data?.id) {
          user = userData.data || userData;
        }
      }
    } catch {
      // /user 端点不可用，仅返回 token
    }

    return new Response(
      JSON.stringify({
        success: true,
        access_token: tokenData.access_token,
        expires_in: tokenData.expires_in,
        user,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (e) {
    return new Response(JSON.stringify({ success: false, error: "内部错误" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
