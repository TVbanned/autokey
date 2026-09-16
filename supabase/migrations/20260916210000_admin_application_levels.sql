-- 后台「活动概览 → 答主报名」需要展示两项：该报名答主的等级、以及用金币补足门槛时提交的金币。
-- 说明：keyflow_gate_payments 开了 RLS 且没有任何 policy，前端（anon/authenticated）读不到，
--       所以这里加一个管理员 token 校验的 RPC，按活动返回每个报名的等级与补足信息。

begin;

create or replace function public.keyflow_admin_application_levels(p_token text, p_activity_id uuid)
returns table (
  application_id uuid,
  answerer_id uuid,
  level integer,
  level_gap integer,
  coins_paid integer,
  gate_status text
)
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.keyflow_is_admin(p_token) then
    raise exception '管理员权限不足';
  end if;

  return query
  select ap.id,
         ap.answerer_id,
         public.keyflow_display_current_level(ap.answerer_id) as level,
         g.level_gap,
         coalesce(g.coins_paid, 0) as coins_paid,
         g.status
  from public.keyflow_applications ap
  left join public.keyflow_gate_payments g on g.application_id = ap.id
  where ap.activity_id = p_activity_id
  order by ap.submitted_at desc;
end;
$$;

grant execute on function public.keyflow_admin_application_levels(text, uuid) to anon, authenticated;

commit;

select jsonb_build_object('ok', true) as applied;
