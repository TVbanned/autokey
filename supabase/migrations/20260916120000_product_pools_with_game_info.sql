-- 商品池列表补上「游戏封面 / Steam 地址」，供后台「添加商品」按所选产品自动带出头图与价格默认值。
-- 返回列变化必须 drop 再建。

drop function if exists public.keyflow_admin_product_pools(text);

create or replace function public.keyflow_admin_product_pools(p_token text)
returns table (
  activity_id uuid,
  product_name text,
  activity_type text,
  pool_available integer,
  pool_claimed integer,
  pool_total integer,
  catalog_count integer,
  game_cover text,
  steam_url text
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
      where trim(both '"' from entry.value::text) = a.id::text)::integer,
    coalesce(a.game_cover, ''),
    coalesce(a.steam_url, '')
  from public.keyflow_activities a
  left join public.keyflow_keys k on k.activity_id = a.id
  where coalesce(a.activity_type, 'game') <> 'comprehensive'
  group by a.id, a.game_name, a.title, a.activity_type, a.game_cover, a.steam_url
  having count(k.id) > 0
      or (select count(*) from jsonb_each(public.keyflow_shop_product_bindings()) as entry(key, value)
           where trim(both '"' from entry.value::text) = a.id::text) > 0
  order by count(k.id) filter (where k.application_id is null and k.claimed_at is null) desc,
           coalesce(nullif(a.game_name, ''), a.title);
end;
$$;

grant execute on function public.keyflow_admin_product_pools(text) to anon, authenticated;
