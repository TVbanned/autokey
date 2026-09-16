-- 活跃口径调整：兑换/报销不再计入活跃（活跃只认 日常投稿 / 测评交付 / 报名领Key）；
-- 掉级阈值 10 天 -> 7 天。以下函数基于线上库当前定义重建。

CREATE OR REPLACE FUNCTION public.keyflow_display_current_level(p_answerer_id uuid, p_day date DEFAULT ((now() AT TIME ZONE 'Asia/Shanghai'::text))::date)
 RETURNS integer
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public'
AS $function$
declare
  v_last date;
  v_cur int;
  v_gap int;
  v_inactive int;
begin
  select last_active_date, current_level into v_last, v_cur
  from public.keyflow_answerers where id = p_answerer_id;
  if v_last is null or v_last = p_day then
    return coalesce(v_cur, 1);
  end if;
  v_gap := (p_day - v_last);
  v_inactive := greatest(0, v_gap - 1);
  return greatest(1, v_cur - (v_inactive / 7));
end;
$function$;

CREATE OR REPLACE FUNCTION public.keyflow_mark_answerer_active(p_answerer_id uuid, p_day date DEFAULT ((now() AT TIME ZONE 'Asia/Shanghai'::text))::date)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_last date;
  v_cur int;
  v_streak int;
  v_gap int;
  v_inactive int;
  v_best int;
  v_recoverable int;
  v_add int;
  v_coins int;
begin
  select last_active_date, current_level, active_streak
    into v_last, v_cur, v_streak
  from public.keyflow_answerers where id = p_answerer_id;
  if not found then raise exception '答主不存在'; end if;

  if v_last is null then
    v_streak := 1;
  elsif (p_day - v_last) = 1 then
    v_streak := v_streak + 1;
  elsif (p_day - v_last) > 1 then
    v_gap := (p_day - v_last);
    v_inactive := greatest(0, v_gap - 1);
    v_cur := greatest(1, v_cur - (v_inactive / 7));
    v_streak := 1;
  end if;

  v_best := public.keyflow_level_from_exp(public.keyflow_answerer_exp(p_answerer_id));
  v_recoverable := greatest(0, v_best - v_cur);
  v_add := least(v_recoverable, v_streak / 3);
  v_cur := v_cur + v_add;
  v_coins := public.keyflow_daily_coins(v_cur);

  update public.keyflow_answerers
     set last_active_date = p_day,
         current_level = v_cur,
         active_streak = v_streak,
         best_level = greatest(best_level, v_best)
   where id = p_answerer_id;

  insert into public.keyflow_coins_ledger (answerer_id, amount, source, note)
  values (p_answerer_id, v_coins, 'daily_activity_reward', '活跃日金币 Lv' || v_cur)
  on conflict do nothing;

  return v_cur;
end;
$function$;

CREATE OR REPLACE FUNCTION public.keyflow_redeem_product(p_answerer_id uuid, p_catalog_id uuid, p_qty integer, p_address jsonb DEFAULT NULL::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_cat record;
  v_cur int;
  v_cost bigint;
  v_balance bigint;
  v_order uuid;
begin
  if p_qty <= 0 then raise exception '数量必须大于 0'; end if;

  select id, title, cost_coins, min_level, stock_left, status, fulfillment_type
    into v_cat
  from public.keyflow_reward_catalog where id = p_catalog_id for update;
  if not found then raise exception '商品不存在'; end if;
  if v_cat.status <> 'on' then raise exception '商品已下架'; end if;
  if v_cat.stock_left < p_qty then raise exception '库存不足'; end if;

  v_cur := public.keyflow_display_current_level(p_answerer_id, (now() at time zone 'Asia/Shanghai')::date);
  if v_cur < v_cat.min_level then
    raise exception '需 Lv% 才能兑换该商品（当前 Lv%）', v_cat.min_level, v_cur;
  end if;

  v_cost := v_cat.cost_coins * p_qty;
  v_balance := public.keyflow_coins_balance(p_answerer_id);
  if v_balance < v_cost then raise exception '金币不足'; end if;

  insert into public.keyflow_redeem_orders
    (answerer_id, catalog_id, qty, points_spent, status, fulfillment_data)
  values (p_answerer_id, p_catalog_id, p_qty, v_cost,
          case when v_cat.fulfillment_type = 'physical' and p_address is null
               then 'pending' else 'pending' end,
          case when v_cat.fulfillment_type = 'physical' then coalesce(p_address, '{}'::jsonb) else '{}'::jsonb end)
  returning id into v_order;

  insert into public.keyflow_coins_ledger (answerer_id, amount, source, ref_id, note)
  values (p_answerer_id, -v_cost, 'redeem', v_order, '兑换 ' || v_cat.title);

  update public.keyflow_reward_catalog set stock_left = stock_left - p_qty where id = p_catalog_id;

  return jsonb_build_object('order_id', v_order, 'spent', v_cost);
end;
$function$;

CREATE OR REPLACE FUNCTION public.keyflow_submit_game_reimbursement(p_answerer_id uuid, p_catalog_id uuid, p_article_url text, p_game_name text, p_game_price numeric)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_price numeric(12, 2);
  v_catalog record;
  v_coins integer;
  v_balance bigint;
  v_order uuid;
begin
  if not exists (select 1 from public.keyflow_answerers where id = p_answerer_id) then raise exception '答主不存在'; end if;
  select id, reimbursement_discount into v_catalog
  from public.keyflow_reward_catalog
  where id = p_catalog_id and status = 'on' and category = 'reimbursement'
  for update;
  if not found then raise exception '报销商品不存在或已下架'; end if;
  if nullif(trim(p_article_url), '') is null or nullif(trim(p_game_name), '') is null then raise exception '请填写稿件链接和游戏名称'; end if;
  v_price := round(p_game_price, 2);
  if v_price <= 0 then raise exception '游戏价格必须大于 0'; end if;
  v_coins := round(v_price * v_catalog.reimbursement_discount / 10 * 100)::integer;
  v_balance := public.keyflow_coins_balance(p_answerer_id);
  if v_balance < v_coins then raise exception '金币不足，需 % 金币', v_coins; end if;

  insert into public.keyflow_game_reimbursement_orders
    (answerer_id, catalog_id, discount, article_url, game_name, game_price, reimbursement_amount, coins_spent)
  values (p_answerer_id, p_catalog_id, v_catalog.reimbursement_discount, trim(p_article_url), trim(p_game_name), v_price, v_price, v_coins)
  returning id into v_order;

  insert into public.keyflow_coins_ledger (answerer_id, amount, source, ref_id, note)
  values (p_answerer_id, -v_coins, 'redeem', v_order, '游戏稿件报销：' || trim(p_game_name));

  return jsonb_build_object('order_id', v_order, 'spent', v_coins, 'reimbursement_amount', v_price);
end;
$function$;
