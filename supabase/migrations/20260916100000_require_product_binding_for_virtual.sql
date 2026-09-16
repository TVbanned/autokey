-- 虚拟卡密商品必须绑定产品（Key 池）才能上架
--
-- 口径（2026-09-16 用户）：虚拟卡密商品（非报销、履约方式=virtual）在上架状态时，
-- 必须绑定产品名（keyflow_economy_config.shop_product_bindings）；
--   - 新建商品默认上架 → 创建时就要求绑定；
--   - 已上架商品保存时若没有绑定 → 拒绝（要么先绑产品，要么先下架）；
--   - 「上架」动作本身也要检查绑定。
-- 实体商品、报销产品不受影响；已下架的商品仍可保存/解绑，方便调整。

create or replace function public.keyflow_admin_product_binding_required_text()
returns text
language sql
immutable
as $$
  select '虚拟卡密商品需要先绑定产品（Key 池）才能上架：请先在「剩余KEY管理」用「Key 码 + 产品名」录入 Key，再回到商品里搜到它';
$$;

create or replace function public.keyflow_admin_catalog_has_product_binding(p_catalog_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from jsonb_each(public.keyflow_shop_product_bindings()) as entry(key, value)
    where entry.key = p_catalog_id::text
  );
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
  v_fulfillment text := case when coalesce(nullif(trim(p_product->>'category'), ''), 'game') = 'reimbursement'
                             then 'virtual' else coalesce(p_product->>'fulfillment_type', 'virtual') end;
  v_product_name text := nullif(trim(coalesce(p_product->>'product_name', '')), '');
  v_activity_id uuid;
  v_sort integer;
begin
  if not public.keyflow_is_admin(p_token) then raise exception '无权操作'; end if;
  if nullif(trim(p_product->>'title'), '') is null then raise exception '商品名不能为空'; end if;
  if v_category not in ('game', 'physical', 'other', 'reimbursement') then raise exception '无效商品类型'; end if;
  if v_discount < 0 or v_discount > 10 then raise exception '折扣等级必须是 0 到 10 之间的数字'; end if;

  -- 新建商品默认上架，所以虚拟卡密商品必须带产品名
  if v_category <> 'reimbursement' and v_fulfillment = 'virtual' and v_product_name is null then
    raise exception '%', public.keyflow_admin_product_binding_required_text();
  end if;

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
     v_fulfillment, 'on', v_sort)
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
  v_fulfillment text;
  v_activity_id uuid;
  v_old_stock_total integer;
  v_old_stock_left integer;
  v_old_status text;
begin
  if not public.keyflow_is_admin(p_token) then raise exception '无权操作'; end if;
  if nullif(trim(p_product->>'title'), '') is null then raise exception '商品名不能为空'; end if;
  if v_category not in ('game', 'physical', 'other', 'reimbursement') then raise exception '无效商品类型'; end if;
  if v_discount < 0 or v_discount > 10 then raise exception '折扣等级必须是 0 到 10 之间的数字'; end if;

  v_fulfillment := case when v_category = 'reimbursement' then 'virtual' else coalesce(p_product->>'fulfillment_type', 'virtual') end;

  -- 先校验产品名，避免「写完一半再报错」
  if v_has_product and v_product_name is not null and v_category <> 'reimbursement' then
    v_activity_id := public.keyflow_shop_find_product(v_product_name);
    if v_activity_id is null then
      raise exception '未找到产品「%」，请先在「剩余KEY管理」录入该产品的 Key', v_product_name;
    end if;
  end if;

  select stock_total, stock_left, status into v_old_stock_total, v_old_stock_left, v_old_status
  from public.keyflow_reward_catalog where id = p_catalog_id for update;
  if not found then raise exception '商品不存在'; end if;

  -- 已上架的虚拟卡密商品不允许保存成「无绑定」：要么先绑产品，要么先下架
  if v_old_status = 'on' and v_category <> 'reimbursement' and v_fulfillment = 'virtual' then
    if not (case when v_has_product
                 then v_product_name is not null
                 else public.keyflow_admin_catalog_has_product_binding(p_catalog_id) end) then
      raise exception '%', public.keyflow_admin_product_binding_required_text();
    end if;
  end if;

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
    fulfillment_type = v_fulfillment
  where id = p_catalog_id;

  if v_has_product then
    if v_product_name is null or v_category = 'reimbursement' then
      -- 清空产品名 = 解绑，库存回到手填口径（已上架的虚拟商品上面已经拦过）
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

create or replace function public.keyflow_admin_set_reward_catalog_status(p_token text, p_catalog_id uuid, p_status text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cat record;
begin
  if not public.keyflow_is_admin(p_token) then raise exception '无权操作'; end if;
  if p_status not in ('on', 'off') then raise exception '无效商品状态'; end if;

  select category, fulfillment_type into v_cat from public.keyflow_reward_catalog where id = p_catalog_id;
  if not found then raise exception '商品不存在'; end if;

  if p_status = 'on'
     and coalesce(v_cat.category, 'game') <> 'reimbursement'
     and coalesce(v_cat.fulfillment_type, 'virtual') = 'virtual'
     and not public.keyflow_admin_catalog_has_product_binding(p_catalog_id) then
    raise exception '%', public.keyflow_admin_product_binding_required_text();
  end if;

  update public.keyflow_reward_catalog set status = p_status where id = p_catalog_id;
  return jsonb_build_object('ok', true);
end;
$$;

grant execute on function public.keyflow_admin_create_reward_catalog(text, jsonb) to anon, authenticated;
grant execute on function public.keyflow_admin_update_reward_catalog(text, uuid, jsonb) to anon, authenticated;
grant execute on function public.keyflow_admin_set_reward_catalog_status(text, uuid, text) to anon, authenticated;
grant execute on function public.keyflow_admin_catalog_has_product_binding(uuid) to anon, authenticated;
grant execute on function public.keyflow_admin_product_binding_required_text() to anon, authenticated;
