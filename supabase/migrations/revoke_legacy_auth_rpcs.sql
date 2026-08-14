-- 关闭遗留的客户端认证 RPC，消除匿名密码爆破、越权注册与硬编码管理员口令泄露。
-- 存量账号密码校验仅由受控 Edge Function answerer-auth-bootstrap（service_role）调用。
revoke all on function public.keyflow_login_answerer(text, text) from public, anon, authenticated;
revoke all on function public.keyflow_register_answerer(text, text, text, text) from public, anon, authenticated;
revoke all on function public.keyflow_register_answerer(text, text, text, text, text) from public, anon, authenticated;
revoke all on function public.keyflow_admin_login(text, text) from public, anon, authenticated;

grant execute on function public.keyflow_login_answerer(text, text) to service_role;

-- 移除硬编码管理员口令的旧登录函数。
drop function if exists public.keyflow_admin_login(text, text);
