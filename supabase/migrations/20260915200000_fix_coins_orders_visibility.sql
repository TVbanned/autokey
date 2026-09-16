-- 修复金币中心「我的兑换记录 / 游戏报销记录」读取失败。
-- 1) keyflow_redeem_orders 对 anon/authenticated 未授任何权限，前端直读必然 permission denied，
--    改为 security definer RPC 取数（与 redeem/fulfill/cancel 一致的既有模式）。
-- 2) keyflow_answerer_game_reimbursement_orders 的 OUT 参数 id 与 keyflow_answerers.id 同名，
--    未加别名的子查询报 column reference "id" is ambiguous，补别名即可。

create or replace function public.keyflow_answerer_redeem_orders(p_answerer_id uuid)
returns table (
  id uuid,
  catalog_id uuid,
  catalog_title text,
  qty integer,
  points_spent integer,
  status text,
  fulfillment_data jsonb,
  admin_note text,
  created_at timestamptz,
  fulfilled_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (select 1 from public.keyflow_answerers a where a.id = p_answerer_id) then
    raise exception '答主不存在';
  end if;

  return query
  select o.id, o.catalog_id, coalesce(c.title, ''), o.qty, o.points_spent, o.status,
         o.fulfillment_data, o.admin_note, o.created_at, o.fulfilled_at
  from public.keyflow_redeem_orders o
  left join public.keyflow_reward_catalog c on c.id = o.catalog_id
  where o.answerer_id = p_answerer_id
  order by o.created_at desc;
end;
$$;

create or replace function public.keyflow_admin_redeem_orders(p_token text)
returns table (
  id uuid,
  answerer_id uuid,
  answerer_name text,
  catalog_id uuid,
  catalog_title text,
  qty integer,
  points_spent integer,
  status text,
  fulfillment_data jsonb,
  admin_note text,
  created_at timestamptz,
  fulfilled_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.keyflow_is_admin(p_token) then raise exception '无权操作'; end if;

  return query
  select o.id, o.answerer_id, a.zhihu_name, o.catalog_id, coalesce(c.title, ''), o.qty,
         o.points_spent, o.status, o.fulfillment_data, o.admin_note, o.created_at, o.fulfilled_at
  from public.keyflow_redeem_orders o
  join public.keyflow_answerers a on a.id = o.answerer_id
  left join public.keyflow_reward_catalog c on c.id = o.catalog_id
  order by o.created_at desc
  limit 200;
end;
$$;

create or replace function public.keyflow_answerer_game_reimbursement_orders(p_answerer_id uuid)
returns table (
  id uuid,
  catalog_id uuid,
  game_name text,
  coins_spent integer,
  status text,
  created_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (select 1 from public.keyflow_answerers a where a.id = p_answerer_id) then
    raise exception '答主不存在';
  end if;

  return query
  select ro.id, ro.catalog_id, ro.game_name, ro.coins_spent, ro.status, ro.created_at
  from public.keyflow_game_reimbursement_orders ro
  where ro.answerer_id = p_answerer_id
  order by ro.created_at desc;
end;
$$;

grant execute on function public.keyflow_answerer_redeem_orders(uuid) to anon, authenticated;
grant execute on function public.keyflow_admin_redeem_orders(text) to anon, authenticated;
grant execute on function public.keyflow_answerer_game_reimbursement_orders(uuid) to anon, authenticated;
