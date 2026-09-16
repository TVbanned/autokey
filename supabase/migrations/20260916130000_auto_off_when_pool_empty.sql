-- 绑定产品 Key 池的商品：池子余量为 0 时自动下架（补货后需手动上架）

create or replace function public.keyflow_shop_sync_pool_stock(p_activity_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_available integer;
  v_catalog uuid;
begin
  if p_activity_id is null then return; end if;

  select count(*) into v_available
  from public.keyflow_keys
  where activity_id = p_activity_id
    and application_id is null
    and claimed_at is null;

  for v_catalog in
    select (entry.key)::uuid
    from jsonb_each(public.keyflow_shop_product_bindings()) as entry(key, value)
    where trim(both '"' from entry.value::text) = p_activity_id::text
  loop
    update public.keyflow_reward_catalog
       set stock_total = v_available,
           stock_left = v_available,
           -- 池子空了就自动下架，避免前台继续卖但发不出 Key
           status = case when v_available <= 0 then 'off' else status end
     where id = v_catalog
       and category <> 'reimbursement';
  end loop;
end;
$$;

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

  v_activity_id := nullif(public.keyflow_shop_product_bindings() ->> p_catalog_id::text, '')::uuid;
  v_auto_issue := v_activity_id is not null
                  and v_cat.fulfillment_type = 'virtual'
                  and coalesce(v_cat.category, 'game') <> 'reimbursement';

  if v_auto_issue then
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
    -- 库存跟着池子走；池子发空后自动下架
    update public.keyflow_reward_catalog
       set stock_left = v_available - p_qty,
           stock_total = v_available - p_qty,
           status = case when v_available - p_qty <= 0 then 'off' else status end
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

-- 存量：已绑定且池子为 0 的商品，统一置为已下架并同步库存
do $$
declare
  v_entry record;
  v_available integer;
begin
  for v_entry in
    select entry.key as catalog_id, trim(both '"' from entry.value::text)::uuid as activity_id
    from jsonb_each(public.keyflow_shop_product_bindings()) as entry(key, value)
  loop
    select count(*) into v_available
    from public.keyflow_keys
    where activity_id = v_entry.activity_id and application_id is null and claimed_at is null;
    update public.keyflow_reward_catalog
       set stock_total = v_available,
           stock_left = v_available,
           status = case when v_available <= 0 then 'off' else status end
     where id = v_entry.catalog_id::uuid
       and category <> 'reimbursement';
  end loop;
end;
$$;

grant execute on function public.keyflow_redeem_product(uuid, uuid, int, jsonb) to anon, authenticated;
