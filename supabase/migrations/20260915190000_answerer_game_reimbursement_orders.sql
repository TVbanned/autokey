create or replace function public.keyflow_answerer_game_reimbursement_orders(p_answerer_id uuid)
returns table (
  id uuid,
  catalog_id uuid,
  game_name text,
  coins_spent integer,
  status text,
  created_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (select 1 from public.keyflow_answerers where id = p_answerer_id) then
    raise exception '答主不存在';
  end if;

  return query
  select ro.id, ro.catalog_id, ro.game_name, ro.coins_spent, ro.status, ro.created_at
  from public.keyflow_game_reimbursement_orders ro
  where ro.answerer_id = p_answerer_id
  order by ro.created_at desc;
end;
$$;

grant execute on function public.keyflow_answerer_game_reimbursement_orders(uuid) to anon, authenticated;
