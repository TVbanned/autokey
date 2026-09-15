-- 报销订单完成态：兼容已执行过初始订单迁移的环境。
alter table public.keyflow_game_reimbursement_orders
  drop constraint if exists keyflow_game_reimbursement_orders_status_check;

alter table public.keyflow_game_reimbursement_orders
  add constraint keyflow_game_reimbursement_orders_status_check
  check (status in ('pending', 'processing', 'reimbursed', 'rejected', 'canceled', 'completed'));

create or replace function public.keyflow_admin_update_game_reimbursement(
  p_token text,
  p_order_id uuid,
  p_status text,
  p_admin_note text default ''
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.keyflow_is_admin(p_token) then raise exception '无权操作'; end if;
  if p_status not in ('pending', 'processing', 'reimbursed', 'rejected', 'canceled', 'completed') then raise exception '无效报销状态'; end if;
  update public.keyflow_game_reimbursement_orders
  set status = p_status,
      admin_note = coalesce(p_admin_note, ''),
      reimbursed_at = case when p_status in ('reimbursed', 'completed') then now() else null end,
      updated_at = now()
  where id = p_order_id;
  if not found then raise exception '报销订单不存在'; end if;
  return jsonb_build_object('ok', true);
end;
$$;

grant execute on function public.keyflow_admin_update_game_reimbursement(text, uuid, text, text) to anon, authenticated;
