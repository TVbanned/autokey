-- 为答主“灰域信风”充值一次性运营金币。
do $$
declare
  v_answerer_id uuid;
begin
  select id into v_answerer_id
  from public.keyflow_answerers
  where zhihu_name = '灰域信风';

  if v_answerer_id is null then
    raise exception '未找到答主：灰域信风';
  end if;

  if not exists (
    select 1 from public.keyflow_coins_ledger
    where answerer_id = v_answerer_id
      and source = 'admin_grant'
      and note = '运营充值：灰域信风 999999 金币'
  ) then
    insert into public.keyflow_coins_ledger (answerer_id, amount, source, note)
    values (v_answerer_id, 999999, 'admin_grant', '运营充值：灰域信风 999999 金币');
  end if;
end;
$$;
