-- 游戏稿件报销：答主先用金币按后台商品配置的折扣兑换，运营后续在知乎系统报销。
alter table public.keyflow_reward_catalog
  add column if not exists reimbursement_discount numeric(3, 1) not null default 8 check (reimbursement_discount >= 0 and reimbursement_discount <= 10);

create table if not exists public.keyflow_game_reimbursement_orders (
  id uuid primary key default gen_random_uuid(),
  answerer_id uuid not null references public.keyflow_answerers(id) on delete cascade,
  catalog_id uuid not null references public.keyflow_reward_catalog(id),
  discount numeric(3, 1) not null check (discount >= 0 and discount <= 10),
  article_url text not null check (length(trim(article_url)) > 0),
  game_name text not null check (length(trim(game_name)) > 0),
  game_price numeric(12, 2) not null check (game_price > 0),
  reimbursement_amount numeric(12, 2) not null check (reimbursement_amount > 0),
  coins_spent integer not null check (coins_spent > 0),
  status text not null default 'pending' check (status in ('pending', 'processing', 'reimbursed', 'rejected', 'canceled', 'completed')),
  admin_note text not null default '',
  reimbursed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists keyflow_game_reimbursement_orders_answerer_idx
  on public.keyflow_game_reimbursement_orders(answerer_id, created_at desc);

alter table public.keyflow_game_reimbursement_orders enable row level security;
revoke all on public.keyflow_game_reimbursement_orders from anon, authenticated;

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

create or replace function public.keyflow_admin_game_reimbursement_orders(p_token text)
returns table (
  id uuid,
  answerer_id uuid,
  answerer_name text,
  catalog_id uuid,
  discount numeric,
  article_url text,
  game_name text,
  game_price numeric,
  reimbursement_amount numeric,
  coins_spent integer,
  status text,
  admin_note text,
  reimbursed_at timestamptz,
  created_at timestamptz,
  updated_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.keyflow_is_admin(p_token) then raise exception '无权操作'; end if;
  return query
  select ro.id, ro.answerer_id, a.zhihu_name, ro.catalog_id, ro.discount, ro.article_url, ro.game_name, ro.game_price,
         ro.reimbursement_amount, ro.coins_spent, ro.status, ro.admin_note,
         ro.reimbursed_at, ro.created_at, ro.updated_at
  from public.keyflow_game_reimbursement_orders ro
  join public.keyflow_answerers a on a.id = ro.answerer_id
  order by ro.created_at desc
  limit 200;
end;
$$;

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

grant execute on function public.keyflow_submit_game_reimbursement(uuid, uuid, text, text, numeric) to anon, authenticated;
grant execute on function public.keyflow_admin_game_reimbursement_orders(text) to anon, authenticated;
grant execute on function public.keyflow_admin_update_game_reimbursement(text, uuid, text, text) to anon, authenticated;
