-- 后台「积分商城 → 金币概览」数据源。
-- 说明：keyflow_coins_ledger 开了 RLS 且没有任何 policy，前端（anon/authenticated）读不到，
--       因此用管理员 token 校验的 RPC 一次返回：汇总、消耗明细、只有台账能查到的消耗、每人余额。

begin;

create or replace function public.keyflow_admin_coins_overview(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.keyflow_is_admin(p_token) then
    raise exception '管理员权限不足';
  end if;

  return jsonb_build_object(
    'summary', jsonb_build_object(
      'granted', (select coalesce(sum(amount), 0) from public.keyflow_coins_ledger where amount > 0),
      'spent', (select coalesce(sum(amount), 0) from public.keyflow_coins_ledger where amount < 0),
      'outstanding', (select coalesce(sum(amount), 0) from public.keyflow_coins_ledger),
      'users', (select count(*) from public.keyflow_answerers),
      'users_with_balance', (select count(*) from public.keyflow_answerers a where public.keyflow_coins_balance(a.id) > 0),
      'negative_users', (select count(*) from public.keyflow_answerers a where public.keyflow_coins_balance(a.id) < 0),
      'granted_daily_active', (select coalesce(sum(amount), 0) from public.keyflow_coins_ledger where source = 'daily_activity_reward'),
      'granted_admin', (select coalesce(sum(amount), 0) from public.keyflow_coins_ledger where source = 'admin_grant')
    ),
    'by_source', (
      select coalesce(jsonb_agg(jsonb_build_object('source', source, 'coins', coins, 'rows', rows) order by coins), '[]'::jsonb)
      from (select source, sum(amount) as coins, count(*) as rows
            from public.keyflow_coins_ledger where amount < 0 group by 1) t
    ),
    'spends', (
      select coalesce(jsonb_agg(entry order by ts desc), '[]'::jsonb) from (
        select jsonb_build_object(
          'kind', 'redeem', 'who', a.zhihu_name, 'what', coalesce(c.title, '（商品已删除）'),
          'category', c.category, 'coins', o.points_spent, 'status', o.status, 'time', o.created_at
        ) as entry, o.created_at as ts
        from public.keyflow_redeem_orders o
        join public.keyflow_answerers a on a.id = o.answerer_id
        left join public.keyflow_reward_catalog c on c.id = o.catalog_id

        union all

        select jsonb_build_object(
          'kind', 'reimbursement', 'who', a.zhihu_name, 'what', '游戏报销：' || r.game_name,
          'category', 'reimbursement', 'coins', r.coins_spent, 'status', r.status, 'time', r.created_at
        ) as entry, r.created_at as ts
        from public.keyflow_game_reimbursement_orders r
        join public.keyflow_answerers a on a.id = r.answerer_id

        union all

        select jsonb_build_object(
          'kind', 'gate', 'who', a.zhihu_name, 'what', '补足门槛：' || coalesce(act.title, '活动'),
          'category', 'level_gate', 'coins', g.coins_paid, 'status', g.status, 'time', g.paid_at
        ) as entry, g.paid_at as ts
        from public.keyflow_gate_payments g
        join public.keyflow_answerers a on a.id = g.answerer_id
        left join public.keyflow_activities act on act.id = g.activity_id
      ) combined
    ),
    -- 台账扣了币、但订单已经被删掉的消耗（例如清理测试订单后残留的扣币记录）
    'ledger_only', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'who', a.zhihu_name, 'note', l.note, 'coins', l.amount, 'time', l.created_at
      ) order by l.created_at desc), '[]'::jsonb)
      from public.keyflow_coins_ledger l
      join public.keyflow_answerers a on a.id = l.answerer_id
      where l.amount < 0
        and l.source = 'redeem'
        and not exists (select 1 from public.keyflow_redeem_orders o where o.id = l.ref_id)
        and not exists (select 1 from public.keyflow_game_reimbursement_orders r where r.id = l.ref_id)
    ),
    'users', (
      select coalesce(jsonb_agg(to_jsonb(x) order by x.balance desc), '[]'::jsonb) from (
        select a.id,
               a.zhihu_name as name,
               coalesce(a.current_level, 1) as level,
               (select coalesce(sum(l.amount), 0) from public.keyflow_coins_ledger l
                 where l.answerer_id = a.id and l.amount > 0) as granted,
               (select coalesce(sum(l.amount), 0) from public.keyflow_coins_ledger l
                 where l.answerer_id = a.id and l.amount < 0) as spent,
               public.keyflow_coins_balance(a.id) as balance,
               a.last_active_date
        from public.keyflow_answerers a
      ) x
    )
  );
end;
$$;

grant execute on function public.keyflow_admin_coins_overview(text) to anon, authenticated;

commit;
