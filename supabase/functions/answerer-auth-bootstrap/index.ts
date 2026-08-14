import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { serve } from "https://deno.land/std@0.177.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const json = (body: Record<string, string>, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

const internalEmail = (userId: string) => `answerer-${userId}@auth.keyflow.invalid`;

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ message: "仅支持 POST 请求" }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) return json({ message: "认证服务配置不完整" }, 500);

  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  try {
    const body = await req.json();
    if (body.action === "login") {
      const zhihuName = typeof body.zhihu_name === "string" ? body.zhihu_name.trim() : "";
      const password = typeof body.password === "string" ? body.password : "";
      if (!zhihuName || !password) return json({ message: "请输入知乎用户名和密码" }, 400);

      const { data: legacyAnswerer, error: loginError } = await admin.rpc("keyflow_login_answerer", {
        p_zhihu_name: zhihuName,
        p_password: password,
      });
      if (loginError || !legacyAnswerer?.id) return json({ message: "知乎用户名或密码错误" }, 401);

      const answererId = legacyAnswerer.id as string;
      const { data: answerer, error: answererError } = await admin
        .from("keyflow_answerers")
        .select("auth_user_id")
        .eq("id", answererId)
        .single();
      if (answererError) return json({ message: "读取答主认证绑定失败" }, 500);

      let authUserId = answerer.auth_user_id as string | null;
      if (!authUserId) {
        const provisionalEmail = internalEmail(answererId);
        const { data: created, error: createError } = await admin.auth.admin.createUser({
          email: provisionalEmail,
          password,
          email_confirm: true,
        });
        if (createError || !created.user) return json({ message: "创建认证会话失败，请稍后重试" }, 500);

        const { data: bound, error: bindError } = await admin
          .from("keyflow_answerers")
          .update({ auth_user_id: created.user.id })
          .eq("id", answererId)
          .is("auth_user_id", null)
          .select("auth_user_id")
          .maybeSingle();

        if (bindError) {
          await admin.auth.admin.deleteUser(created.user.id);
          return json({ message: "绑定认证账号失败，请稍后重试" }, 500);
        }

        if (!bound?.auth_user_id) {
          await admin.auth.admin.deleteUser(created.user.id);
          const { data: concurrentBinding, error: concurrentError } = await admin
            .from("keyflow_answerers")
            .select("auth_user_id")
            .eq("id", answererId)
            .single();
          if (concurrentError || !concurrentBinding.auth_user_id) {
            return json({ message: "认证绑定正在处理中，请稍后重试" }, 409);
          }
          authUserId = concurrentBinding.auth_user_id;
        } else {
          authUserId = bound.auth_user_id;
        }
      }

      const { error: syncError } = await admin.auth.admin.updateUserById(authUserId, {
        email: internalEmail(answererId),
        password,
        email_confirm: true,
      });
      if (syncError) return json({ message: "同步认证账号失败，请稍后重试" }, 500);

      const { error: roleError } = await admin
        .from("keyflow_user_roles")
        .upsert({ user_id: authUserId, role: "answerer" }, { onConflict: "user_id" });
      if (roleError) return json({ message: "设置答主权限失败，请稍后重试" }, 500);

      return json({ internal_email: internalEmail(answererId) });
    }

    if (body.action === "register") {
      const code = typeof body.code === "string" ? body.code.trim() : "";
      const zhihuName = typeof body.zhihu_name === "string" ? body.zhihu_name.trim() : "";
      const accountAddress = typeof body.account_address === "string" ? body.account_address.trim() : "";
      const wechatId = typeof body.wechat_id === "string" ? body.wechat_id.trim() : "";
      const password = typeof body.password === "string" ? body.password : "";
      if (!code || !zhihuName || !accountAddress || !wechatId || !password) {
        return json({ message: "请完整填写注册信息" }, 400);
      }
      if (password.length < 6) return json({ message: "密码至少 6 位" }, 400);

      const generatedId = crypto.randomUUID();
      const { data: created, error: createError } = await admin.auth.admin.createUser({
        id: generatedId,
        email: internalEmail(generatedId),
        password,
        email_confirm: true,
      });
      if (createError || !created.user) return json({ message: "创建认证账号失败，请稍后重试" }, 500);

      const { error: registerError } = await admin.rpc("keyflow_register_answerer_for_auth", {
        p_auth_user_id: created.user.id,
        p_code: code,
        p_zhihu_name: zhihuName,
        p_account_address: accountAddress,
        p_wechat_id: wechatId,
        p_password: password,
      });
      if (registerError) {
        await admin.auth.admin.deleteUser(created.user.id);
        return json({ message: registerError.message || "注册失败" }, 400);
      }

      return json({ internal_email: internalEmail(created.user.id) });
    }

    return json({ message: "不支持的操作" }, 400);
  } catch {
    return json({ message: "请求处理失败，请稍后重试" }, 500);
  }
});
