-- 按 Key ID 获取明文，仅供后台库存列表的按需查看。
create or replace function public.keyflow_reveal_key(p_key_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
begin
  return (select key_value from keyflow_keys where id = p_key_id);
end;
$$;

grant execute on function public.keyflow_reveal_key(uuid) to anon, authenticated;
