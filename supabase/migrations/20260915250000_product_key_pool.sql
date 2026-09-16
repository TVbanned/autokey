-- 非游戏产品 Key 池（不改表结构）
--
-- 背景：keyflow_keys.activity_id 是 NOT NULL，且「剩余KEY管理」的「游戏名」列来自关联的 keyflow_activities。
-- 为了让非游戏产品（实体周边、第三方卡密等）也能入库 Key，这里给每个产品建一条
-- activity_type='merch' 的「产品活动」记录承载 Key：title / game_name 都填产品名，
-- is_online=false（不进公开申领页）、status='completed'（不进招募看板）。
--
-- 商品与产品 Key 池的关联写在 keyflow_economy_config 里（key='shop_product_bindings'，
-- value 形如 {"<catalog_id>": "<activity_id>"}），不改任何表结构。

-- 读取商品 ↔ 产品池绑定表。
create or replace function public.keyflow_shop_product_bindings()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select value from public.keyflow_economy_config where key = 'shop_product_bindings'), '{}'::jsonb);
$$;

-- 写入/覆盖单条绑定（内部使用，不对外授权）。
create or replace function public.keyflow_shop_bind_product(p_catalog_id uuid, p_activity_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.keyflow_economy_config (key, value, updated_at)
  values ('shop_product_bindings', jsonb_build_object(p_catalog_id::text, p_activity_id::text), now())
  on conflict (key) do update
    set value = coalesce(public.keyflow_economy_config.value, '{}'::jsonb)
                || jsonb_build_object(p_catalog_id::text, p_activity_id::text),
        updated_at = now();
end;
$$;

-- 解绑（内部使用）。
create or replace function public.keyflow_shop_unbind_product(p_catalog_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.keyflow_economy_config
     set value = coalesce(value, '{}'::jsonb) - p_catalog_id::text,
         updated_at = now()
   where key = 'shop_product_bindings';
end;
$$;

-- 按产品名查已存在的产品/活动（游戏活动与产品活动都能命中）。
create or replace function public.keyflow_shop_find_product(p_product_name text)
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select a.id
  from public.keyflow_activities a
  where coalesce(a.activity_type, 'game') <> 'comprehensive'
    and lower(trim(coalesce(nullif(a.game_name, ''), a.title))) = lower(trim(coalesce(p_product_name, '')))
  order by (coalesce(a.activity_type, 'game') = 'merch') desc, a.created_at asc
  limit 1;
$$;

-- 按产品名取产品 ID，没有就建一条产品活动（内部使用）。
create or replace function public.keyflow_shop_ensure_product(p_product_name text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_name text := trim(coalesce(p_product_name, ''));
  v_id uuid;
begin
  if v_name = '' then raise exception '产品名不能为空'; end if;
  v_id := public.keyflow_shop_find_product(v_name);
  if v_id is not null then return v_id; end if;

  insert into public.keyflow_activities
    (title, game_name, activity_type, status, is_online, description, review_requirement)
  values
    (v_name, v_name, 'merch', 'completed', false, '商城产品：仅用于承载该产品的 Key 库存，不是游戏测评活动。', '')
  returning id into v_id;
  return v_id;
end;
$$;

-- 池子数量变化后，把绑定该池子的商品库存同步成池子余量（池子即库存）。
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
           stock_left = v_available
     where id = v_catalog
       and category <> 'reimbursement';
  end loop;
end;
$$;

-- 管理端：录入非游戏产品 Key（key 码 + 产品名）。
-- 未识别平台按 unknown 入库（前端平台列显示 /），不会像游戏 Key 那样强制按 Steam 处理。
create or replace function public.keyflow_admin_import_product_keys(p_token text, p_product_name text, p_keys jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_activity_id uuid;
  v_inserted_count integer := 0;
  v_total_count integer := 0;
begin
  if not public.keyflow_is_admin(p_token) then raise exception '无权操作'; end if;
  if nullif(trim(coalesce(p_product_name, '')), '') is null then raise exception '请填写产品名'; end if;
  if coalesce(jsonb_typeof(p_keys), 'null') <> 'array' then raise exception 'Key 数据格式不正确'; end if;

  select count(*) into v_total_count
  from jsonb_array_elements(p_keys) as item
  where trim(coalesce(item->>'key_value', '')) <> '';

  if v_total_count = 0 then raise exception '请填写至少一个 Key'; end if;

  v_activity_id := public.keyflow_shop_ensure_product(p_product_name);

  with imported as (
    select
      trim(item->>'key_value') as key_value,
      case
        when coalesce(item->>'platform', '') in ('steam', 'ubi', 'switch', 'ps5', 'epic', 'unknown')
          then coalesce(item->>'platform', 'unknown')
        else 'unknown'
      end as platform
    from jsonb_array_elements(p_keys) as item
    where trim(coalesce(item->>'key_value', '')) <> ''
  ), inserted as (
    insert into public.keyflow_keys (activity_id, key_value, platform)
    select v_activity_id, key_value, platform from imported
    on conflict (activity_id, key_value) do nothing
    returning id
  )
  select count(*) into v_inserted_count from inserted;

  perform public.keyflow_shop_sync_pool_stock(v_activity_id);

  return jsonb_build_object(
    'activity_id', v_activity_id,
    'product_name', trim(p_product_name),
    'inserted_count', v_inserted_count,
    'duplicate_count', v_total_count - v_inserted_count,
    'pool_available', (select count(*) from public.keyflow_keys
                        where activity_id = v_activity_id and application_id is null and claimed_at is null)
  );
end;
$$;

-- 管理端：产品池一览（用于编辑商品弹窗的「产品名」搜索与池子余量展示）。
create or replace function public.keyflow_admin_product_pools(p_token text)
returns table (
  activity_id uuid,
  product_name text,
  activity_type text,
  pool_available integer,
  pool_claimed integer,
  pool_total integer,
  catalog_count integer
)
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.keyflow_is_admin(p_token) then raise exception '无权操作'; end if;

  return query
  select
    a.id,
    coalesce(nullif(a.game_name, ''), a.title),
    coalesce(a.activity_type, 'game'),
    (count(k.id) filter (where k.application_id is null and k.claimed_at is null))::integer,
    (count(k.id) filter (where k.application_id is null and k.claimed_at is not null))::integer,
    count(k.id)::integer,
    (select count(*) from jsonb_each(public.keyflow_shop_product_bindings()) as entry(key, value)
      where trim(both '"' from entry.value::text) = a.id::text)::integer
  from public.keyflow_activities a
  left join public.keyflow_keys k on k.activity_id = a.id
  where coalesce(a.activity_type, 'game') <> 'comprehensive'
  group by a.id, a.game_name, a.title, a.activity_type
  having count(k.id) > 0
      or (select count(*) from jsonb_each(public.keyflow_shop_product_bindings()) as entry(key, value)
           where trim(both '"' from entry.value::text) = a.id::text) > 0
  order by count(k.id) filter (where k.application_id is null and k.claimed_at is null) desc,
           coalesce(nullif(a.game_name, ''), a.title);
end;
$$;

-- 公开：商品 ↔ 产品名 / 池子余量（用于商品列表展示与前台缺货判断）。
create or replace function public.keyflow_shop_catalog_pools()
returns table (
  catalog_id uuid,
  activity_id uuid,
  product_name text,
  pool_left integer
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  return query
  select
    (entry.key)::uuid,
    a.id,
    coalesce(nullif(a.game_name, ''), a.title),
    (count(k.id) filter (where k.application_id is null and k.claimed_at is null))::integer
  from jsonb_each(public.keyflow_shop_product_bindings()) as entry(key, value)
  join public.keyflow_activities a on a.id = trim(both '"' from entry.value::text)::uuid
  left join public.keyflow_keys k on k.activity_id = a.id
  group by entry.key, a.id, a.game_name, a.title;
end;
$$;

grant execute on function public.keyflow_admin_import_product_keys(text, text, jsonb) to anon, authenticated;
grant execute on function public.keyflow_admin_product_pools(text) to anon, authenticated;
grant execute on function public.keyflow_shop_catalog_pools() to anon, authenticated;
revoke all on function public.keyflow_shop_bind_product(uuid, uuid) from public;
revoke all on function public.keyflow_shop_unbind_product(uuid) from public;
revoke all on function public.keyflow_shop_ensure_product(text) from public;
revoke all on function public.keyflow_shop_sync_pool_stock(uuid) from public;
revoke all on function public.keyflow_shop_find_product(text) from public;
