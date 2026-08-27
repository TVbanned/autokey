-- HD-2D 生成额度：GameJourney 等级基础额度 + 管理员充值 + 生成扣减流水

create table if not exists public.hd2d_quota_ledger (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.keyflow_answerers(id) on delete cascade,
  amount integer not null check (amount <> 0),
  source text not null check (source in ('admin_adjustment', 'generation', 'generation_refund')),
  request_id uuid,
  note text,
  created_by uuid references public.keyflow_admin_users(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists hd2d_quota_ledger_user_created_idx on public.hd2d_quota_ledger(user_id, created_at desc);
create unique index if not exists hd2d_quota_ledger_generation_request_idx
  on public.hd2d_quota_ledger(user_id, request_id, source)
  where request_id is not null and source in ('generation', 'generation_refund');

alter table public.hd2d_quota_ledger enable row level security;
revoke all on public.hd2d_quota_ledger from anon, authenticated;

drop function if exists public.keyflow_hd2d_quota(uuid);
create function public.keyflow_hd2d_quota(p_answerer_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_points integer;
  v_level integer;
  v_manual integer;
  v_used integer;
begin
  if not exists (select 1 from keyflow_answerers where id = p_answerer_id) then
    raise exception '用户不存在';
  end if;

  select
    (select count(distinct activity_id) * 50 from keyflow_applications where answerer_id = p_answerer_id and status = 'selected') +
    (select count(*) * 300 from keyflow_applications a join keyflow_deliveries d on d.application_id = a.id where a.answerer_id = p_answerer_id) +
    (select count(*) * 80 from keyflow_daily_submissions where answerer_id = p_answerer_id)
  into v_points;

  v_points := coalesce(v_points, 0);
  v_level := case
    when v_points >= 15000 then 10 when v_points >= 11000 then 9 when v_points >= 8000 then 8
    when v_points >= 5500 then 7 when v_points >= 3500 then 6 when v_points >= 2000 then 5
    when v_points >= 1000 then 4 when v_points >= 500 then 3 when v_points >= 200 then 2 else 1
  end;
  select coalesce(sum(amount) filter (where source = 'admin_adjustment'), 0),
         coalesce(-sum(amount) filter (where source = 'generation'), 0) -
         coalesce(sum(amount) filter (where source = 'generation_refund'), 0)
    into v_manual, v_used
  from hd2d_quota_ledger where user_id = p_answerer_id;

  return jsonb_build_object(
    'level', v_level, 'points', v_points, 'base_quota', v_level,
    'manual_quota', v_manual, 'used_quota', v_used,
    'total_quota', v_level + v_manual, 'remaining_quota', greatest(0, v_level + v_manual - v_used)
  );
end;
$$;

drop function if exists public.keyflow_hd2d_consume_quota(uuid, uuid);
create function public.keyflow_hd2d_consume_quota(p_answerer_id uuid, p_request_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_quota jsonb;
begin
  perform pg_advisory_xact_lock(hashtext(p_answerer_id::text));
  select keyflow_hd2d_quota(p_answerer_id) into v_quota;
  if coalesce((v_quota->>'remaining_quota')::integer, 0) < 1 then
    raise exception '生成额度已用完';
  end if;
  insert into hd2d_quota_ledger(user_id, amount, source, request_id, note)
  values (p_answerer_id, -1, 'generation', p_request_id, 'HD-2D 图像生成');
  return keyflow_hd2d_quota(p_answerer_id);
end;
$$;

drop function if exists public.keyflow_hd2d_refund_quota(uuid, uuid);
create function public.keyflow_hd2d_refund_quota(p_answerer_id uuid, p_request_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform pg_advisory_xact_lock(hashtext(p_answerer_id::text));
  if exists (select 1 from hd2d_quota_ledger where user_id = p_answerer_id and request_id = p_request_id and source = 'generation') then
    insert into hd2d_quota_ledger(user_id, amount, source, request_id, note)
    values (p_answerer_id, 1, 'generation_refund', p_request_id, '生成失败，自动退回额度')
    on conflict do nothing;
  end if;
end;
$$;

drop function if exists public.keyflow_admin_hd2d_quota_summaries(text);
create function public.keyflow_admin_hd2d_quota_summaries(p_token text)
returns table (
  user_id uuid, zhihu_name text, account_address text,
  level integer, points integer, base_quota integer, manual_quota integer, used_quota integer, total_quota integer, remaining_quota integer
)
language plpgsql
security definer
set search_path = public
as $$
begin
  if not keyflow_is_admin(p_token) then raise exception '无权操作'; end if;
  return query
  select a.id, a.zhihu_name, a.account_address,
    (q.data->>'level')::integer, (q.data->>'points')::integer, (q.data->>'base_quota')::integer,
    (q.data->>'manual_quota')::integer, (q.data->>'used_quota')::integer, (q.data->>'total_quota')::integer,
    (q.data->>'remaining_quota')::integer
  from keyflow_answerers a
  cross join lateral (select keyflow_hd2d_quota(a.id) as data) q
  order by a.created_at desc;
end;
$$;

drop function if exists public.keyflow_admin_hd2d_add_quota(text, uuid, integer, text);
create function public.keyflow_admin_hd2d_add_quota(p_token text, p_answerer_id uuid, p_amount integer, p_note text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_admin_id uuid;
begin
  v_admin_id := resolve_admin_token(p_token);
  if v_admin_id is null then raise exception '无权操作'; end if;
  if p_amount <= 0 then raise exception '充值额度必须大于 0'; end if;
  if not exists (select 1 from keyflow_answerers where id = p_answerer_id) then raise exception '用户不存在'; end if;
  insert into hd2d_quota_ledger(user_id, amount, source, note, created_by)
  values (p_answerer_id, p_amount, 'admin_adjustment', nullif(trim(coalesce(p_note, '')), ''), v_admin_id);
  return keyflow_hd2d_quota(p_answerer_id);
end;
$$;

grant execute on function public.keyflow_hd2d_quota(uuid) to anon, authenticated, service_role;
grant execute on function public.keyflow_hd2d_consume_quota(uuid, uuid) to service_role;
grant execute on function public.keyflow_hd2d_refund_quota(uuid, uuid) to service_role;
grant execute on function public.keyflow_admin_hd2d_quota_summaries(text) to anon, authenticated;
grant execute on function public.keyflow_admin_hd2d_add_quota(text, uuid, integer, text) to anon, authenticated;
