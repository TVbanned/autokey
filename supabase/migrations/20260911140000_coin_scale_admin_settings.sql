-- 金币 S 系数：作用于每日活跃金币；并提供后台系数更新 RPC。
create or replace function public.keyflow_daily_coins(p_level int)
returns int
language sql
stable
set search_path = public
as $$
  select round(
    (c.daily_coins * coalesce(
      (select (value #>> '{}')::numeric
       from public.keyflow_economy_config
       where key = 'coin_scale_s'),
      1
    ))::numeric
  )::int
  from public.keyflow_level_config c
  where c.level = p_level;
$$;

create or replace function public.keyflow_admin_update_coin_scale(
  p_token text,
  p_scale numeric
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_admin uuid;
  v_scale numeric;
begin
  v_admin := public.resolve_admin_token(p_token);
  if v_admin is null then
    raise exception '无权操作';
  end if;

  v_scale := round(p_scale, 2);
  if v_scale is null or v_scale < 0 or v_scale > 10 then
    raise exception 'S 系数必须在 0 到 10 之间';
  end if;

  insert into public.keyflow_economy_config (key, value, updated_at)
  values ('coin_scale_s', to_jsonb(v_scale), now())
  on conflict (key) do update
    set value = excluded.value,
        updated_at = now();

  return jsonb_build_object(
    'key', 'coin_scale_s',
    'value', v_scale,
    'updated_at', now()
  );
end;
$$;

grant execute on function public.keyflow_daily_coins(int) to anon, authenticated;
grant execute on function public.keyflow_admin_update_coin_scale(text, numeric) to anon, authenticated;
