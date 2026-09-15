-- 将报销兑换改为后台商品配置：报销产品使用 reimbursement_discount（0-10）计算金币。
alter table public.keyflow_reward_catalog
  add column if not exists reimbursement_discount numeric(3, 1) not null default 8 check (reimbursement_discount >= 0 and reimbursement_discount <= 10);

alter table public.keyflow_game_reimbursement_orders
  add column if not exists catalog_id uuid references public.keyflow_reward_catalog(id),
  add column if not exists discount numeric(3, 1) check (discount >= 0 and discount <= 10);

drop function if exists public.keyflow_submit_game_reimbursement(uuid, text, text, numeric);
create or replace function public.keyflow_submit_game_reimbursement(
  p_answerer_id uuid,
  p_catalog_id uuid,
  p_article_url text,
  p_game_name text,
  p_game_price numeric
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
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

  perform public.keyflow_mark_answerer_active(p_answerer_id);
  return jsonb_build_object('order_id', v_order, 'spent', v_coins, 'reimbursement_amount', v_price);
end;
$$;

grant execute on function public.keyflow_submit_game_reimbursement(uuid, uuid, text, text, numeric) to anon, authenticated;
