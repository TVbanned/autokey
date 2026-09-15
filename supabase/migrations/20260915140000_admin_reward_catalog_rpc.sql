-- 商品目录仅允许管理员通过受控 RPC 写入，避免向匿名用户开放 RLS 写策略。
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
begin
  if not public.keyflow_is_admin(p_token) then raise exception '无权操作'; end if;
  if nullif(trim(p_product->>'title'), '') is null then raise exception '商品名不能为空'; end if;
  if v_category not in ('game', 'physical', 'other', 'reimbursement') then raise exception '无效商品类型'; end if;
  if v_discount < 0 or v_discount > 10 then raise exception '折扣等级必须是 0 到 10 之间的数字'; end if;

  insert into public.keyflow_reward_catalog
    (title, image_url, category, cost_coins, reimbursement_discount, min_level, stock_total, stock_left, fulfillment_type, status)
  values
    (trim(p_product->>'title'), coalesce(p_product->>'image_url', ''), v_category,
     case when v_category = 'reimbursement' then 1 else greatest(coalesce((p_product->>'cost_coins')::integer, 1), 1) end,
     v_discount, greatest(coalesce((p_product->>'min_level')::integer, 0), 0),
     case when v_category = 'reimbursement' then 0 else greatest(v_stock, 0) end,
     case when v_category = 'reimbursement' then 0 else greatest(v_stock, 0) end,
     case when v_category = 'reimbursement' then 'virtual' else coalesce(p_product->>'fulfillment_type', 'virtual') end,
     'on')
  returning id into v_id;

  return jsonb_build_object('id', v_id);
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
  v_old_stock_total integer;
  v_old_stock_left integer;
begin
  if not public.keyflow_is_admin(p_token) then raise exception '无权操作'; end if;
  if nullif(trim(p_product->>'title'), '') is null then raise exception '商品名不能为空'; end if;
  if v_category not in ('game', 'physical', 'other', 'reimbursement') then raise exception '无效商品类型'; end if;
  if v_discount < 0 or v_discount > 10 then raise exception '折扣等级必须是 0 到 10 之间的数字'; end if;

  select stock_total, stock_left into v_old_stock_total, v_old_stock_left from public.keyflow_reward_catalog where id = p_catalog_id for update;
  if not found then raise exception '商品不存在'; end if;

  update public.keyflow_reward_catalog
  set title = trim(p_product->>'title'),
      image_url = coalesce(p_product->>'image_url', ''),
      category = v_category,
      cost_coins = case when v_category = 'reimbursement' then 1 else greatest(coalesce((p_product->>'cost_coins')::integer, 1), 1) end,
      reimbursement_discount = v_discount,
      min_level = greatest(coalesce((p_product->>'min_level')::integer, 0), 0),
      stock_total = case when v_category = 'reimbursement' then 0 else greatest(v_stock, 0) end,
      stock_left = case when v_category = 'reimbursement' then 0 else greatest(0, v_old_stock_left + greatest(v_stock, 0) - v_old_stock_total) end,
      fulfillment_type = case when v_category = 'reimbursement' then 'virtual' else coalesce(p_product->>'fulfillment_type', 'virtual') end
  where id = p_catalog_id;
  return jsonb_build_object('ok', true);
end;
$$;

create or replace function public.keyflow_admin_set_reward_catalog_status(p_token text, p_catalog_id uuid, p_status text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.keyflow_is_admin(p_token) then raise exception '无权操作'; end if;
  if p_status not in ('on', 'off') then raise exception '无效商品状态'; end if;
  update public.keyflow_reward_catalog set status = p_status where id = p_catalog_id;
  if not found then raise exception '商品不存在'; end if;
  return jsonb_build_object('ok', true);
end;
$$;

grant execute on function public.keyflow_admin_create_reward_catalog(text, jsonb) to anon, authenticated;
grant execute on function public.keyflow_admin_update_reward_catalog(text, uuid, jsonb) to anon, authenticated;
grant execute on function public.keyflow_admin_set_reward_catalog_status(text, uuid, text) to anon, authenticated;
