-- 远程数据库尚未创建删除 RPC；后台自定义登录态的请求使用 anon 角色。
create or replace function public.keyflow_delete_keys(p_key_ids uuid[])
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  deleted_count int;
begin
  delete from keyflow_keys
  where id = any(p_key_ids);

  get diagnostics deleted_count = row_count;
  return jsonb_build_object('deleted_count', deleted_count);
end;
$$;

grant execute on function public.keyflow_delete_keys(uuid[]) to anon, authenticated;
