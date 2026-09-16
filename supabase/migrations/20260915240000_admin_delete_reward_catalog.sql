-- 后台删除商品：已被兑换 / 生成报销订单的商品不允许删除（保留历史），其余可删除。
create or replace function public.keyflow_admin_delete_reward_catalog(p_token text, p_catalog_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_orders integer;
begin
  if not public.keyflow_is_admin(p_token) then raise exception '无权操作'; end if;

  select count(*) into v_orders
  from public.keyflow_redeem_orders
  where catalog_id = p_catalog_id;
  if v_orders > 0 then
    raise exception '该商品已有 % 条兑换记录，不能删除；如需停售请改为下架', v_orders;
  end if;

  if exists (select 1 from public.keyflow_game_reimbursement_orders where catalog_id = p_catalog_id) then
    raise exception '该商品已有报销订单，不能删除；如需停售请改为下架';
  end if;

  delete from public.keyflow_reward_catalog where id = p_catalog_id;
  if not found then raise exception '商品不存在'; end if;

  return jsonb_build_object('ok', true);
end;
$$;

grant execute on function public.keyflow_admin_delete_reward_catalog(text, uuid) to anon, authenticated;
