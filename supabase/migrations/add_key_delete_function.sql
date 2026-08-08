-- 批量删除 Key
drop function if exists public.keyflow_delete_keys(uuid[]);

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

grant execute on function public.keyflow_delete_keys(uuid[]) to authenticated;
