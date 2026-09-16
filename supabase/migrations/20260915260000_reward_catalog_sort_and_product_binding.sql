-- 积分商城：商品拖拽排序 + 商品绑定产品 Key 池（编辑弹窗「产品名」搜索）
--
-- 1) 排序：keyflow_reward_catalog.sort_order 已存在，这里只补一个「按 id 数组写顺序」的管理端 RPC；
--    新建商品排在最后，避免和已有排序打架。
-- 2) 绑定：商品 ↔ 产品名（= keyflow_activities 里承载 Key 的那条记录）的关系写在
--    keyflow_economy_config 的 key='shop_product_bindings'（见 20260915250000），不改表结构。
--    绑定后「池子即库存」：商品库存显示 = 池子里未领取的 Key 数，兑换时也从池子取。

create or replace function public.keyflow_admin_reorder_reward_catalog(p_token text, p_ids uuid[])
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.keyflow_is_admin(p_token) then raise exception '无权操作'; end if;
  if p_ids is null or array_length(p_ids, 1) is null then raise exception '缺少商品顺序'; end if;

  update public.keyflow_reward_catalog c
     set sort_order = ordered.position
    from (
      select id, (ordinality - 1)::integer as position
      from unnest(p_ids) with ordinality as item(id, ordinality)
    ) as ordered
   where c.id = ordered.id;

  return jsonb_build_object('ok', true, 'count', array_length(p_ids, 1));
end;
$$;

create or replace function public.keyflow_admin_create_reward_catalog(p_token text, p_product jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
  v_category text := coalesce(nullif(trim(p_product->>'category'), ''), 'game');
  v_discount numeric := coalesce((p_product->>'reimbursement_discount')::numeric, 8);
  v_stock integer := coalesce((p_product->>'stock_total')::integer, 0);
  v_product_name text := nullif(trim(coalesce(p_product->>'product_name', '')), '');
  v_activity_id uuid;
  v_sort integer;
begin
  if not public.keyflow_is_admin(p_token) then raise exception '无权操作'; end if;
  if nullif(trim(p_product->>'title'), '') is null then raise exception '商品名不能为空'; end if;
  if v_category not in ('game', 'physical', 'other', 'reimbursement') then raise exception '无效商品类型'; end if;
  if v_discount < 0 or v_discount > 10 then raise exception '折扣等级必须是 0 到 10 之间的数字'; end if;

  if v_product_name is not null and v_category <> 'reimbursement' then
    v_activity_id := public.keyflow_shop_find_product(v_product_name);
    if v_activity_id is null then
      raise exception '未找到产品「%」，请先在「剩余KEY管理」录入该产品的 Key', v_product_name;
    end if;
  end if;

  select coalesce(max(sort_order), 0) + 1 into v_sort from public.keyflow_reward_catalog;

  insert into public.keyflow_reward_catalog
    (title, description, image_url, category, card_tags, cost_coins, reimbursement_discount,
     min_level, stock_total, stock_left, fulfillment_type, status, sort_order)
  values
    (trim(p_product->>'title'), left(trim(coalesce(p_product->>'description', '')), 80),
     coalesce(p_product->>'image_url', ''), v_category, trim(coalesce(p_product->>'card_tags', '')),
     case when v_category = 'reimbursement' then 1 else greatest(coalesce((p_product->>'cost_coins')::integer, 1), 1) end,
     v_discount, greatest(coalesce((p_product->>'min_level')::integer, 0), 0),
     case when v_category = 'reimbursement' then 0 else greatest(v_stock, 0) end,
     case when v_category = 'reimbursement' then 0 else greatest(v_stock, 0) end,
     case when v_category = 'reimbursement' then 'virtual' else coalesce(p_product->>'fulfillment_type', 'virtual') end,
     'on', v_sort)
  returning id into v_id;

  if v_activity_id is not null then
    perform public.keyflow_shop_bind_product(v_id, v_activity_id);
    perform public.keyflow_shop_sync_pool_stock(v_activity_id);
  end if;

  return jsonb_build_object('id', v_id, 'product_name', coalesce(v_product_name, ''));
end;
$$;

create or replace function public.keyflow_admin_update_reward_catalog(p_token text, p_catalog_id uuid, p_product jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_category text := coalesce(nullif(trim(p_product->>'category'), ''), 'game');
  v_discount numeric := coalesce((p_product->>'reimbursement_discount')::numeric, 8);
  v_stock integer := coalesce((p_product->>'stock_total')::integer, 0);
  v_has_product boolean := p_product ? 'product_name';
  v_product_name text := nullif(trim(coalesce(p_product->>'product_name', '')), '');
  v_activity_id uuid;
  v_old_stock_total integer;
  v_old_stock_left integer;
begin
  if not public.keyflow_is_admin(p_token) then raise exception '无权操作'; end if;
  if nullif(trim(p_product->>'title'), '') is null then raise exception '商品名不能为空'; end if;
  if v_category not in ('game', 'physical', 'other', 'reimbursement') then raise exception '无效商品类型'; end if;
  if v_discount < 0 or v_discount > 10 then raise exception '折扣等级必须是 0 到 10 之间的数字'; end if;

  -- 先校验产品名，避免「写完一半再报错」
  if v_has_product and v_product_name is not null and v_category <> 'reimbursement' then
    v_activity_id := public.keyflow_shop_find_product(v_product_name);
    if v_activity_id is null then
      raise exception '未找到产品「%」，请先在「剩余KEY管理」录入该产品的 Key', v_product_name;
    end if;
  end if;

  select stock_total, stock_left into v_old_stock_total, v_old_stock_left
  from public.keyflow_reward_catalog where id = p_catalog_id for update;
  if not found then raise exception '商品不存在'; end if;

  update public.keyflow_reward_catalog set
    title = trim(p_product->>'title'),
    description = left(trim(coalesce(p_product->>'description', '')), 80),
    image_url = coalesce(p_product->>'image_url', ''),
    category = v_category,
    card_tags = trim(coalesce(p_product->>'card_tags', '')),
    cost_coins = case when v_category = 'reimbursement' then 1 else greatest(coalesce((p_product->>'cost_coins')::integer, 1), 1) end,
    reimbursement_discount = v_discount,
    min_level = greatest(coalesce((p_product->>'min_level')::integer, 0), 0),
    stock_total = case when v_category = 'reimbursement' then 0 else greatest(v_stock, 0) end,
    stock_left = case when v_category = 'reimbursement' then 0
                      else greatest(0, v_old_stock_left + greatest(v_stock, 0) - v_old_stock_total) end,
    fulfillment_type = case when v_category = 'reimbursement' then 'virtual' else coalesce(p_product->>'fulfillment_type', 'virtual') end
  where id = p_catalog_id;

  if v_has_product then
    if v_product_name is null or v_category = 'reimbursement' then
      -- 清空产品名 = 解绑，库存回到手填口径
      perform public.keyflow_shop_unbind_product(p_catalog_id);
    else
      perform public.keyflow_shop_bind_product(p_catalog_id, v_activity_id);
      -- 池子即库存：绑定/换池后立刻用池子余量覆盖库存
      perform public.keyflow_shop_sync_pool_stock(v_activity_id);
    end if;
  end if;

  return jsonb_build_object('ok', true, 'product_name', coalesce(v_product_name, ''));
end;
$$;

grant execute on function public.keyflow_admin_reorder_reward_catalog(text, uuid[]) to anon, authenticated;
grant execute on function public.keyflow_admin_create_reward_catalog(text, jsonb) to anon, authenticated;
grant execute on function public.keyflow_admin_update_reward_catalog(text, uuid, jsonb) to anon, authenticated;
