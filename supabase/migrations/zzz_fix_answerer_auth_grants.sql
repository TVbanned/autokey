-- 紧急修复：恢复答主端认证相关 RPC 的 EXECUTE 权限
-- 问题：生产环境答主登录报 "permission denied for function keyflow_login_answerer"（code 42501）。
-- 原因：这些 security definer 函数对 anon 的执行权限在生产库缺失，导致答主登录/注册/找回密码全部失败。
-- 修复：为 anon、authenticated 重新授予执行权限（按函数名覆盖所有重载，跳过不存在的重载，避免报错）。

do $$
declare
  r record;
begin
  for r in
    select p.oid
    from pg_proc p
    where p.pronamespace = 'public'::regnamespace
      and p.proname in (
        'keyflow_login_answerer',
        'keyflow_register_answerer',
        'keyflow_request_password_reset',
        'keyflow_reset_password',
        'keyflow_check_zhihu_name',
        'keyflow_check_account_address'
      )
  loop
    execute format('grant execute on function public.%s to anon, authenticated', r.oid::regprocedure);
  end loop;
end;
$$;
