-- 「金币概览」排除内部/测试账号：灰域信风（管理员）与测试用户。
-- 这两个账号的进账、出账、余额一律不计入看板（汇总卡、消耗明细、每人余额都不出现）。

begin;

create or replace function public.keyflow_admin_coins_overview(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  -- 内部/测试账号，不进金币概览
  v_exclude uuid[] := array[
    '723486d2-04e9-4065-888a-188c6f41251f'::uuid,  -- 灰域信风（管理员）
    '04e3e911-da83-4aa5-9657-a30ddf855d1c'::uuid   -- 测试用户
  ];
begin
  if not public.keyflow_is_admin(p_token) then
    raise exception '管理员权限不足';
  end if;

  return jsonb_build_object(
    'excluded', jsonb_build_object(
      'ids', to_jsonb(v_exclude),
      'names', (select coalesce(jsonb_agg(zhihu_name), '[]'::jsonb) from public.keyflow_answerers where id = any(v_exclude))
    ),
    'summary', jsonb_build_object(
      'granted', (select coalesce(sum(amount), 0) from public.keyflow_coins_ledger
                   where amount > 0 and not (answerer_id = any(v_exclude))),
      'spent', (select coalesce(sum(amount), 0) from public.keyflow_coins_ledger
                 where amount < 0 and not (answerer_id = any(v_exclude))),
      'outstanding', (select coalesce(sum(amount), 0) from public.keyflow_coins_ledger
                       where not (answerer_id = any(v_exclude))),
      'users', (select count(*) from public.keyflow_answerers where not (id = any(v_exclude))),
      'users_with_balance', (select count(*) from public.keyflow_answerers a
                              where not (a.id = any(v_exclude)) and public.keyflow_coins_balance(a.id) > 0),
      'negative_users', (select count(*) from public.keyflow_answerers a
                          where not (a.id = any(v_exclude)) and public.keyflow_coins_balance(a.id) < 0),
      'granted_daily_active', (select coalesce(sum(amount), 0) from public.keyflow_coins_ledger
                                where source = 'daily_activity_reward' and not (answerer_id = any(v_exclude))),
      'granted_admin', (select coalesce(sum(amount), 0) from public.keyflow_coins_ledger
                         where source = 'admin_grant' and not (answerer_id = any(v_exclude)))
    ),
    'by_source', (
      select coalesce(jsonb_agg(jsonb_build_object('source', source, 'coins', coins, 'rows', rows) order by coins), '[]'::jsonb)
      from (select source, sum(amount) as coins, count(*) as rows
            from public.keyflow_coins_ledger
            where amount < 0 and not (answerer_id = any(v_exclude))
            group by 1) t
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
        where not (o.answerer_id = any(v_exclude))

        union all

        select jsonb_build_object(
          'kind', 'reimbursement', 'who', a.zhihu_name, 'what', '游戏报销：' || r.game_name,
          'category', 'reimbursement', 'coins', r.coins_spent, 'status', r.status, 'time', r.created_at
        ) as entry, r.created_at as ts
        from public.keyflow_game_reimbursement_orders r
        join public.keyflow_answerers a on a.id = r.answerer_id
        where not (r.answerer_id = any(v_exclude))

        union all

        select jsonb_build_object(
          'kind', 'gate', 'who', a.zhihu_name, 'what', '补足门槛：' || coalesce(act.title, '活动'),
          'category', 'level_gate', 'coins', g.coins_paid, 'status', g.status, 'time', g.paid_at
        ) as entry, g.paid_at as ts
        from public.keyflow_gate_payments g
        join public.keyflow_answerers a on a.id = g.answerer_id
        left join public.keyflow_activities act on act.id = g.activity_id
        where not (g.answerer_id = any(v_exclude))
      ) combined
    ),
    -- 保留字段供对账（被排除账号已过滤，通常为空）
    'ledger_only', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'who', a.zhihu_name, 'note', l.note, 'coins', l.amount, 'time', l.created_at
      ) order by l.created_at desc), '[]'::jsonb)
      from public.keyflow_coins_ledger l
      join public.keyflow_answerers a on a.id = l.answerer_id
      where l.amount < 0
        and l.source = 'redeem'
        and not (l.answerer_id = any(v_exclude))
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
        where not (a.id = any(v_exclude))
      ) x
    )
  );
end;
$$;

grant execute on function public.keyflow_admin_coins_overview(text) to anon, authenticated;

commit;
