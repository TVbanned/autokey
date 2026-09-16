-- 兑换时实时发放产品 Key（虚拟卡密）
--
-- 现状：keyflow_redeem_product 只建订单，虚拟商品由后台人工发货。
-- 本次：若商品绑定了产品 Key 池（keyflow_economy_config.shop_product_bindings），
--       兑换时立刻从池子里取一条未发放的 Key，标记已领取，写进订单 fulfillment_data，
--       订单直接置为 fulfilled；池子空了则报「暂时缺货」且不扣金币、不建单。
-- 没有绑定产品池的商品保持原状（人工发货）。

create or replace function public.keyflow_redeem_product(
  p_answerer_id uuid,
  p_catalog_id uuid,
  p_qty int,
  p_address jsonb default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cat record;
  v_cur int;
  v_cost bigint;
  v_balance bigint;
  v_order uuid;
  v_activity_id uuid;
  v_key_ids uuid[];
  v_keys jsonb;
  v_available integer;
  v_fulfillment jsonb;
  v_status text := 'pending';
  v_fulfilled_at timestamptz := null;
  v_auto_issue boolean := false;
begin
  if p_qty <= 0 then raise exception '数量必须大于 0'; end if;

  select id, title, category, cost_coins, min_level, stock_left, status, fulfillment_type
    into v_cat
  from public.keyflow_reward_catalog where id = p_catalog_id for update;
  if not found then raise exception '商品不存在'; end if;
  if v_cat.status <> 'on' then raise exception '商品已下架'; end if;

  -- 商品绑定的产品 Key 池（不改表结构）
  v_activity_id := nullif(public.keyflow_shop_product_bindings() ->> p_catalog_id::text, '')::uuid;
  v_auto_issue := v_activity_id is not null
                  and v_cat.fulfillment_type = 'virtual'
                  and coalesce(v_cat.category, 'game') <> 'reimbursement';

  if v_auto_issue then
    -- 池子即库存：池子里的未领取 Key 不够就是缺货，直接拦住（不扣金币、不建单）
    select count(*) into v_available
    from public.keyflow_keys
    where activity_id = v_activity_id
      and application_id is null
      and claimed_at is null;
    if v_available < p_qty then
      raise exception '暂时缺货，该商品已兑完';
    end if;
  elsif v_cat.stock_left < p_qty then
    raise exception '库存不足';
  end if;

  v_cur := public.keyflow_display_current_level(p_answerer_id, (now() at time zone 'Asia/Shanghai')::date);
  if v_cur < v_cat.min_level then
    raise exception '需 Lv% 才能兑换该商品（当前 Lv%）', v_cat.min_level, v_cur;
  end if;

  v_cost := v_cat.cost_coins * p_qty;
  v_balance := public.keyflow_coins_balance(p_answerer_id);
  if v_balance < v_cost then raise exception '金币不足'; end if;

  v_fulfillment := case when v_cat.fulfillment_type = 'physical'
                        then coalesce(p_address, '{}'::jsonb)
                        else '{}'::jsonb end;

  if v_auto_issue then
    -- 锁定并取走池子里最早入库的 Key
    select array_agg(picked.id order by picked.created_at, picked.id),
           jsonb_agg(jsonb_build_object('key_value', picked.key_value, 'platform', picked.platform)
                     order by picked.created_at, picked.id)
      into v_key_ids, v_keys
    from (
      select id, key_value, platform, created_at
      from public.keyflow_keys
      where activity_id = v_activity_id
        and application_id is null
        and claimed_at is null
      order by created_at asc, id asc
      limit p_qty
      for update
    ) as picked;

    if v_key_ids is null or coalesce(array_length(v_key_ids, 1), 0) < p_qty then
      raise exception '暂时缺货，该商品已兑完';
    end if;

    update public.keyflow_keys set claimed_at = now() where id = any(v_key_ids);
    v_status := 'fulfilled';
    v_fulfilled_at := now();
    v_fulfillment := v_fulfillment || jsonb_build_object(
      'keys', v_keys,
      'auto_issued', true,
      'issued_at', now(),
      'product_name', coalesce((
        select coalesce(nullif(a.game_name, ''), a.title)
        from public.keyflow_activities a where a.id = v_activity_id
      ), '')
    );
  end if;

  insert into public.keyflow_redeem_orders
    (answerer_id, catalog_id, qty, points_spent, status, fulfillment_data, fulfilled_at)
  values (p_answerer_id, p_catalog_id, p_qty, v_cost, v_status, v_fulfillment, v_fulfilled_at)
  returning id into v_order;

  insert into public.keyflow_coins_ledger (answerer_id, amount, source, ref_id, note)
  values (p_answerer_id, -v_cost, 'redeem', v_order, '兑换 ' || v_cat.title);

  if v_auto_issue then
    -- 库存跟着池子走，避免两套口径打架
    update public.keyflow_reward_catalog
       set stock_left = v_available - p_qty,
           stock_total = v_available - p_qty
     where id = p_catalog_id;
  else
    update public.keyflow_reward_catalog set stock_left = stock_left - p_qty where id = p_catalog_id;
  end if;

  perform public.keyflow_mark_answerer_active(p_answerer_id);

  return jsonb_build_object(
    'order_id', v_order,
    'spent', v_cost,
    'status', v_status,
    'fulfilled', v_auto_issue,
    'keys', coalesce(v_keys, '[]'::jsonb)
  );
end;
$$;

grant execute on function public.keyflow_redeem_product(uuid, uuid, int, jsonb) to anon, authenticated;
