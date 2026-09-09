-- ============================================================
-- GameJourney v1 等级/金币/门槛/兑换 数据层（本地草稿，未执行）
-- 文件：20260908120000_gj_levels_coins_gates_shop_draft.sql
-- 状态：LOCAL DRAFT ONLY — 未在任何数据库执行
-- 依据：design-docs/gamejourney-v1-implementation-spec.md
-- 命名沿用 keyflow_* 与现有 security definer 函数模式。
-- ============================================================

-- ---------- 1. 答主表新增状态列 ----------
alter table public.keyflow_answerers
  add column if not exists last_active_date date,
  add column if not exists current_level int not null default 1,
  add column if not exists active_streak int not null default 0,
  add column if not exists best_level int not null default 1;

-- ---------- 2. 日常投稿：经验值固化列 ----------
alter table public.keyflow_daily_submissions
  add column if not exists xp_value int not null default 40;

-- 存量投稿按旧规则 80 回填（只此一次）
update public.keyflow_daily_submissions set xp_value = 80 where xp_value = 40;

-- ---------- 3. 活动表：等级门槛与金币补足 ----------
alter table public.keyflow_activities
  add column if not exists min_level int not null default 0,
  add column if not exists coin_gate_enabled boolean not null default false,
  add column if not exists coin_per_level int not null default 800;

-- ---------- 4. 新表 ----------
create table if not exists public.keyflow_economy_config (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);

create table if not exists public.keyflow_level_config (
  level int primary key,
  title text,
  min_exp bigint not null,
  daily_post_limit int not null,
  daily_coins int not null
);

create table if not exists public.keyflow_coins_ledger (
  id uuid primary key default gen_random_uuid(),
  answerer_id uuid not null references public.keyflow_answerers(id) on delete cascade,
  amount int not null check (amount <> 0),
  source text not null check (source in (
    'legacy_grant','daily_activity_reward','activity_reward',
    'admin_grant','admin_deduct','redeem','redeem_refund',
    'level_gate','level_gate_refund')),
  ref_id uuid,
  note text not null default '',
  created_by uuid references public.keyflow_admin_users(id) on delete set null,
  created_at timestamptz not null default now()
);
create unique index if not exists coins_ledger_daily_unique
  on public.keyflow_coins_ledger(answerer_id, (created_at at time zone 'Asia/Shanghai')::date, source)
  where source = 'daily_activity_reward';
create index if not exists coins_ledger_answerer_idx
  on public.keyflow_coins_ledger(answerer_id, created_at desc);

create table if not exists public.keyflow_reward_catalog (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  category text not null default 'game',
  image_url text not null default '',
  description text not null default '',
  cost_coins int not null check (cost_coins > 0),
  min_level int not null default 0,
  fulfillment_type text not null default 'virtual' check (fulfillment_type in ('virtual','physical')),
  stock_total int not null default 0 check (stock_total >= 0),
  stock_left int not null default 0 check (stock_left >= 0),
  status text not null default 'on' check (status in ('on','off')),
  sort_order int not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists public.keyflow_redeem_orders (
  id uuid primary key default gen_random_uuid(),
  answerer_id uuid not null references public.keyflow_answerers(id) on delete cascade,
  catalog_id uuid not null references public.keyflow_reward_catalog(id),
  qty int not null check (qty > 0),
  points_spent int not null check (points_spent > 0),
  status text not null default 'pending' check (status in ('pending','fulfilled','completed','canceled','refunded')),
  fulfillment_data jsonb not null default '{}',
  admin_note text not null default '',
  created_at timestamptz not null default now(),
  fulfilled_at timestamptz
);

create table if not exists public.keyflow_gate_payments (
  id uuid primary key default gen_random_uuid(),
  application_id uuid not null unique references public.keyflow_applications(id) on delete cascade,
  answerer_id uuid not null references public.keyflow_answerers(id) on delete cascade,
  activity_id uuid not null references public.keyflow_activities(id) on delete cascade,
  level_gap int not null check (level_gap > 0),
  coins_paid int not null check (coins_paid > 0),
  status text not null default 'paid' check (status in ('paid','refunded')),
  paid_at timestamptz not null default now(),
  refunded_at timestamptz
);

-- RLS 与可见性
alter table public.keyflow_level_config enable row level security;
alter table public.keyflow_economy_config enable row level security;
alter table public.keyflow_reward_catalog enable row level security;
alter table public.keyflow_coins_ledger enable row level security;
alter table public.keyflow_redeem_orders enable row level security;
alter table public.keyflow_gate_payments enable row level security;

create policy "level config read" on public.keyflow_level_config
  for select to anon, authenticated using (true);
create policy "economy config read" on public.keyflow_economy_config
  for select to anon, authenticated using (true);
create policy "reward catalog read" on public.keyflow_reward_catalog
  for select to anon, authenticated using (true);

revoke all on public.keyflow_coins_ledger from anon, authenticated;
revoke all on public.keyflow_redeem_orders from anon, authenticated;
revoke all on public.keyflow_gate_payments from anon, authenticated;

-- ---------- 5. 种子：等级配置 1-100 ----------
insert into public.keyflow_level_config (level, title, min_exp, daily_post_limit, daily_coins)
select g.level,
       case when g.level <= 10
            then (array['初识玩家','游戏学徒','测评新秀','锐评达人','资深鉴赏家','金牌测评师','游戏领航员','大师测评官','传奇鉴赏家','创世测评王'])[g.level]
            else null end,
       case
         when g.level <= 10 then (array[0,200,500,1000,2000,3500,5500,8000,11000,15000])[g.level]
         when g.level <= 20 then 15000 + (g.level-10) * 5000
         when g.level <= 30 then 65000 + (g.level-20) * 8000
         when g.level <= 50 then 145000 + (g.level-30) * 12000
         when g.level <= 80 then 385000 + (g.level-50) * 16000
         else 865000 + (g.level-80) * 20000 end,
       case when g.level <= 2 then 1 when g.level <= 5 then 2 when g.level <= 8 then 3 else 4 end,
       case
         when g.level <= 10 then round((2500 * g.level) / 30.0)::int
         when g.level <= 20 then round((25000 + 2000*(g.level-10)) / 30.0)::int
         when g.level <= 30 then round((45000 + 1250*(g.level-20)) / 30.0)::int
         when g.level <= 40 then round((57500 + 750*(g.level-30)) / 30.0)::int
         when g.level <= 50 then round((65000 + 500*(g.level-40)) / 30.0)::int
         else 2333 end
from generate_series(1, 100) g.level
on conflict (level) do update set
  min_exp = excluded.min_exp,
  daily_post_limit = excluded.daily_post_limit,
  daily_coins = excluded.daily_coins;

insert into public.keyflow_economy_config (key, value) values
  ('coin_unit_rmb', '0.01'::jsonb),
  ('coin_scale_s', '1.0'::jsonb),
  ('decay_days_per_level', '10'::jsonb),
  ('recovery_days_per_level', '3'::jsonb),
  ('daily_post_xp', '40'::jsonb),
  ('legacy_post_xp', '80'::jsonb),
  ('default_coin_per_level_gate', '800'::jsonb)
on conflict (key) do nothing;

-- ---------- 6. 纯函数 ----------
create or replace function public.keyflow_level_from_exp(p_exp bigint)
returns int
language sql stable
set search_path = public
as $$
  select max(level) from public.keyflow_level_config where min_exp <= p_exp;
$$;

create or replace function public.keyflow_daily_coins(p_level int)
returns int
language sql stable
set search_path = public
as $$
  select daily_coins from public.keyflow_level_config where level = p_level;
$$;

create or replace function public.keyflow_daily_post_limit(p_level int)
returns int
language sql stable
set search_path = public
as $$
  select daily_post_limit from public.keyflow_level_config where level = p_level;
$$;

create or replace function public.keyflow_coins_balance(p_answerer_id uuid)
returns bigint
language sql stable
set search_path = public
as $$
  select coalesce(sum(amount), 0) from public.keyflow_coins_ledger where answerer_id = p_answerer_id;
$$;

-- 历史/经验等级（best）与经验值
create or replace function public.keyflow_answerer_exp(p_answerer_id uuid)
returns bigint
language sql stable
set search_path = public
as $$
  select
    (select count(distinct activity_id) * 50 from keyflow_applications
      where answerer_id = p_answerer_id and status = 'selected')
    + (select count(*) * 300 from keyflow_applications a
        join keyflow_deliveries d on d.application_id = a.id
       where a.answerer_id = p_answerer_id)
    + (select coalesce(sum(xp_value), 0) from keyflow_daily_submissions
       where answerer_id = p_answerer_id);
$$;

-- ---------- 7. 展示当前等级（读路径，不写库） ----------
create or replace function public.keyflow_display_current_level(p_answerer_id uuid, p_day date default (now() at time zone 'Asia/Shanghai')::date)
returns int
language plpgsql stable
set search_path = public
as $$
declare
  v_last date;
  v_cur int;
  v_gap int;
  v_inactive int;
begin
  select last_active_date, current_level into v_last, v_cur
  from public.keyflow_answerers where id = p_answerer_id;
  if v_last is null or v_last = p_day then
    return coalesce(v_cur, 1);
  end if;
  v_gap := (p_day - v_last);
  v_inactive := greatest(0, v_gap - 1);
  return greatest(1, v_cur - (v_inactive / 10));
end;
$$;

-- ---------- 8. 活跃结算（写路径：衰减→恢复→发当日金币） ----------
create or replace function public.keyflow_mark_answerer_active(p_answerer_id uuid, p_day date default (now() at time zone 'Asia/Shanghai')::date)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_last date;
  v_cur int;
  v_streak int;
  v_gap int;
  v_inactive int;
  v_best int;
  v_recoverable int;
  v_add int;
  v_coins int;
begin
  select last_active_date, current_level, active_streak
    into v_last, v_cur, v_streak
  from public.keyflow_answerers where id = p_answerer_id;
  if not found then raise exception '答主不存在'; end if;

  if v_last is null then
    v_streak := 1;
  elsif (p_day - v_last) = 1 then
    v_streak := v_streak + 1;
  elsif (p_day - v_last) > 1 then
    v_gap := (p_day - v_last);
    v_inactive := greatest(0, v_gap - 1);
    v_cur := greatest(1, v_cur - (v_inactive / 10));
    v_streak := 1;
  end if;

  v_best := public.keyflow_level_from_exp(public.keyflow_answerer_exp(p_answerer_id));
  v_recoverable := greatest(0, v_best - v_cur);
  v_add := least(v_recoverable, v_streak / 3);
  v_cur := v_cur + v_add;
  v_coins := public.keyflow_daily_coins(v_cur);

  update public.keyflow_answerers
     set last_active_date = p_day,
         current_level = v_cur,
         active_streak = v_streak,
         best_level = greatest(best_level, v_best)
   where id = p_answerer_id;

  insert into public.keyflow_coins_ledger (answerer_id, amount, source, note)
  values (p_answerer_id, v_coins, 'daily_activity_reward', '活跃日金币 Lv' || v_cur)
  on conflict do nothing;

  return v_cur;
end;
$$;

-- ---------- 9. 投稿触发：上限 + xp_value + 活跃结算 ----------
create or replace function public.keyflow_enforce_daily_submission_limit_v2()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_level int;
  v_limit int;
  v_today int;
begin
  if new.answerer_id is null then
    new.xp_value := 40;
    return new;
  end if;

  v_level := public.keyflow_display_current_level(new.answerer_id, (now() at time zone 'Asia/Shanghai')::date);
  v_limit := public.keyflow_daily_post_limit(v_level);

  select count(*) into v_today
  from public.keyflow_daily_submissions
  where answerer_id = new.answerer_id
    and (created_at at time zone 'Asia/Shanghai')::date = (now() at time zone 'Asia/Shanghai')::date;

  if v_today >= v_limit then
    raise exception '今日投稿已达上限（Lv% 每天 % 篇）', v_level, v_limit;
  end if;

  new.xp_value := 40;
  return new;
end;
$$;

drop trigger if exists trg_daily_submission_limit_v2 on public.keyflow_daily_submissions;
create trigger trg_daily_submission_limit_v2
  before insert on public.keyflow_daily_submissions
  for each row execute function public.keyflow_enforce_daily_submission_limit_v2();

create or replace function public.keyflow_mark_active_on_daily_submission()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if new.answerer_id is not null then
    perform public.keyflow_mark_answerer_active(new.answerer_id);
  end if;
  return new;
end;
$$;

drop trigger if exists trg_mark_active_on_daily_submission on public.keyflow_daily_submissions;
create trigger trg_mark_active_on_daily_submission
  after insert on public.keyflow_daily_submissions
  for each row execute function public.keyflow_mark_active_on_daily_submission();

-- ---------- 10. 交付 / 领 Key 触发活跃结算 ----------
create or replace function public.keyflow_mark_active_on_delivery()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare v_answerer uuid;
begin
  select answerer_id into v_answerer from public.keyflow_applications where id = new.application_id;
  if v_answerer is not null then
    perform public.keyflow_mark_answerer_active(v_answerer);
  end if;
  return new;
end;
$$;

drop trigger if exists trg_mark_active_on_delivery on public.keyflow_deliveries;
create trigger trg_mark_active_on_delivery
  after insert on public.keyflow_deliveries
  for each row execute function public.keyflow_mark_active_on_delivery();

create or replace function public.keyflow_mark_active_on_key_claim()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare v_answerer uuid;
begin
  if new.claimed_at is not null and (old.claimed_at is null or old.application_id is distinct from new.application_id) then
    select answerer_id into v_answerer from public.keyflow_applications where id = new.application_id;
    if v_answerer is not null then
      perform public.keyflow_mark_answerer_active(v_answerer);
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_mark_active_on_key_claim on public.keyflow_keys;
create trigger trg_mark_active_on_key_claim
  after update of claimed_at, application_id on public.keyflow_keys
  for each row execute function public.keyflow_mark_active_on_key_claim();

-- ---------- 11. 报名门槛 + 金币补足（自助报名 RPC） ----------
create or replace function public.keyflow_apply_with_gate(
  p_activity_id uuid,
  p_answerer_id uuid,
  p_zhihu_id text,
  p_zhihu_name text,
  p_wechat_name text,
  p_profile_url text,
  p_expected_word_count int,
  p_selected_platform text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_act record;
  v_cur int;
  v_gap int;
  v_fee int;
  v_balance bigint;
  v_app uuid;
begin
  select min_level, coin_gate_enabled, coin_per_level into v_act
  from public.keyflow_activities where id = p_activity_id;
  if not found then raise exception '活动不存在'; end if;

  v_cur := public.keyflow_display_current_level(p_answerer_id, (now() at time zone 'Asia/Shanghai')::date);
  v_gap := greatest(0, coalesce(v_act.min_level, 0) - v_cur);

  if v_gap > 0 then
    if not coalesce(v_act.coin_gate_enabled, false) then
      raise exception '该活动要求 Lv%，当前等级不足', v_act.min_level;
    end if;
    v_fee := v_gap * coalesce(v_act.coin_per_level, 800);
    v_balance := public.keyflow_coins_balance(p_answerer_id);
    if v_balance < v_fee then
      raise exception '金币不足：需 % 金币补足 % 级门槛（当前余额 %）', v_fee, v_gap, v_balance;
    end if;
  end if;

  insert into public.keyflow_applications
    (activity_id, zhihu_id, zhihu_name, wechat_name, profile_url, expected_word_count,
     selected_platform, answerer_id, status)
  values (p_activity_id, p_zhihu_id, p_zhihu_name, p_wechat_name, p_profile_url,
          p_expected_word_count, coalesce(p_selected_platform, 'steam'), p_answerer_id, 'pending')
  returning id into v_app;

  if v_gap > 0 then
    insert into public.keyflow_coins_ledger (answerer_id, amount, source, ref_id, note)
    values (p_answerer_id, -v_fee, 'level_gate', v_app, '补足 Lv' || v_cur || '→' || v_act.min_level || ' 门槛');
    insert into public.keyflow_gate_payments (application_id, answerer_id, activity_id, level_gap, coins_paid)
    values (v_app, p_answerer_id, p_activity_id, v_gap, v_fee);
  end if;

  perform public.keyflow_mark_answerer_active(p_answerer_id);
  return jsonb_build_object('application_id', v_app, 'gate_gap', v_gap, 'gate_fee', v_fee);
end;
$$;

-- 未入选/取消删除自动退款
create or replace function public.keyflow_refund_gate_payment()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v_pay record;
  v_has_key boolean;
begin
  if tg_op = 'DELETE' then
    select * into v_pay from public.keyflow_gate_payments where application_id = old.id and status = 'paid';
    if v_pay.id is not null then
      update public.keyflow_gate_payments set status = 'refunded', refunded_at = now() where id = v_pay.id;
      insert into public.keyflow_coins_ledger (answerer_id, amount, source, ref_id, note)
      values (v_pay.answerer_id, v_pay.coins_paid, 'level_gate_refund', old.id, '报名删除自动退款');
    end if;
    return old;
  end if;

  if new.status in ('rejected','pending') and old.status is distinct from new.status then
    select exists (select 1 from public.keyflow_keys k
                   where k.application_id = new.id and k.claimed_at is not null)
      into v_has_key;
    if not coalesce(v_has_key, false) then
      select * into v_pay from public.keyflow_gate_payments where application_id = new.id and status = 'paid';
      if v_pay.id is not null then
        update public.keyflow_gate_payments set status = 'refunded', refunded_at = now() where id = v_pay.id;
        insert into public.keyflow_coins_ledger (answerer_id, amount, source, ref_id, note)
        values (v_pay.answerer_id, v_pay.coins_paid, 'level_gate_refund', new.id, '未入选自动退款');
      end if;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_refund_gate_on_application on public.keyflow_applications;
create trigger trg_refund_gate_on_application
  after update of status on public.keyflow_applications
  for each row execute function public.keyflow_refund_gate_payment();
create trigger trg_refund_gate_on_application_delete
  before delete on public.keyflow_applications
  for each row execute function public.keyflow_refund_gate_payment();

-- ---------- 12. 兑换 ----------
create or replace function public.keyflow_redeem_product(
  p_answerer_id uuid,
  p_catalog_id uuid,
  p_qty int,
  p_address jsonb default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cat record;
  v_cur int;
  v_cost bigint;
  v_balance bigint;
  v_order uuid;
begin
  if p_qty <= 0 then raise exception '数量必须大于 0'; end if;

  select id, title, cost_coins, min_level, stock_left, status, fulfillment_type
    into v_cat
  from public.keyflow_reward_catalog where id = p_catalog_id for update;
  if not found then raise exception '商品不存在'; end if;
  if v_cat.status <> 'on' then raise exception '商品已下架'; end if;
  if v_cat.stock_left < p_qty then raise exception '库存不足'; end if;

  v_cur := public.keyflow_display_current_level(p_answerer_id, (now() at time zone 'Asia/Shanghai')::date);
  if v_cur < v_cat.min_level then
    raise exception '需 Lv% 才能兑换该商品（当前 Lv%）', v_cat.min_level, v_cur;
  end if;

  v_cost := v_cat.cost_coins * p_qty;
  v_balance := public.keyflow_coins_balance(p_answerer_id);
  if v_balance < v_cost then raise exception '金币不足'; end if;

  insert into public.keyflow_redeem_orders
    (answerer_id, catalog_id, qty, points_spent, status, fulfillment_data)
  values (p_answerer_id, p_catalog_id, p_qty, v_cost,
          case when v_cat.fulfillment_type = 'physical' and p_address is null
               then 'pending' else 'pending' end,
          case when v_cat.fulfillment_type = 'physical' then coalesce(p_address, '{}'::jsonb) else '{}'::jsonb end)
  returning id into v_order;

  insert into public.keyflow_coins_ledger (answerer_id, amount, source, ref_id, note)
  values (p_answerer_id, -v_cost, 'redeem', v_order, '兑换 ' || v_cat.title);

  update public.keyflow_reward_catalog set stock_left = stock_left - p_qty where id = p_catalog_id;

  perform public.keyflow_mark_answerer_active(p_answerer_id);
  return jsonb_build_object('order_id', v_order, 'spent', v_cost);
end;
$$;

-- 管理端：兑换取消（仅 pending 未发货）与发货
create or replace function public.keyflow_admin_cancel_redeem(p_token text, p_order_id uuid)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare v_order record;
begin
  if not public.keyflow_is_admin(p_token) then raise exception '无权操作'; end if;
  select * into v_order from public.keyflow_redeem_orders where id = p_order_id for update;
  if not found then raise exception '订单不存在'; end if;
  if v_order.status <> 'pending' then raise exception '仅待发货订单可取消'; end if;
  update public.keyflow_redeem_orders set status = 'canceled' where id = p_order_id;
  update public.keyflow_reward_catalog set stock_left = stock_left + v_order.qty where id = v_order.catalog_id;
  insert into public.keyflow_coins_ledger (answerer_id, amount, source, ref_id, note)
  values (v_order.answerer_id, v_order.points_spent, 'redeem_refund', p_order_id, '兑换取消退款');
  return jsonb_build_object('ok', true);
end;
$$;

create or replace function public.keyflow_admin_fulfill_redeem(p_token text, p_order_id uuid, p_fulfillment jsonb default '{}')
returns jsonb
language plpgsql security definer set search_path = public
as $$
begin
  if not public.keyflow_is_admin(p_token) then raise exception '无权操作'; end if;
  update public.keyflow_redeem_orders
     set status = 'fulfilled', fulfillment_data = coalesce(p_fulfillment, '{}'::jsonb), fulfilled_at = now()
   where id = p_order_id and status = 'pending';
  if not found then raise exception '订单不存在或非待发货状态'; end if;
  return jsonb_build_object('ok', true);
end;
$$;

-- ---------- 13. 管理端：金币调整 / 状态查询 / 一次性存量带入 ----------
create or replace function public.keyflow_admin_adjust_coins(p_token text, p_answerer_id uuid, p_amount int, p_note text default '')
returns bigint
language plpgsql security definer set search_path = public
as $$
declare v_admin uuid;
begin
  v_admin := public.resolve_admin_token(p_token);
  if v_admin is null then raise exception '无权操作'; end if;
  if p_amount = 0 then raise exception '金额不能为 0'; end if;
  if not exists (select 1 from public.keyflow_answerers where id = p_answerer_id) then
    raise exception '答主不存在';
  end if;
  insert into public.keyflow_coins_ledger (answerer_id, amount, source, note, created_by)
  values (p_answerer_id, p_amount, case when p_amount > 0 then 'admin_grant' else 'admin_deduct' end,
          coalesce(nullif(trim(p_note), ''), '运营调整'), v_admin);
  return public.keyflow_coins_balance(p_answerer_id);
end;
$$;

create or replace function public.keyflow_answerer_economy_state(p_answerer_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare v_today date := (now() at time zone 'Asia/Shanghai')::date;
begin
  return jsonb_build_object(
    'exp', public.keyflow_answerer_exp(p_answerer_id),
    'best_level', public.keyflow_level_from_exp(public.keyflow_answerer_exp(p_answerer_id)),
    'current_level', public.keyflow_display_current_level(p_answerer_id, v_today),
    'coins_balance', public.keyflow_coins_balance(p_answerer_id),
    'last_active_date', (select last_active_date from public.keyflow_answerers where id = p_answerer_id)
  );
end;
$$;

-- 一次性存量带入（上线时手动执行一次；幂等：已有 legacy_grant 则跳过）
create or replace function public.keyflow_grant_legacy_coins()
returns bigint
language plpgsql security definer set search_path = public
as $$
declare v_uid uuid; v_pts bigint; v_cnt bigint := 0;
begin
  for v_uid in select id from public.keyflow_answerers loop
    if not exists (select 1 from public.keyflow_coins_ledger where answerer_id = v_uid and source = 'legacy_grant') then
      v_pts := public.keyflow_answerer_exp(v_uid);
      insert into public.keyflow_coins_ledger (answerer_id, amount, source, note)
      values (v_uid, v_pts, 'legacy_grant', '存量经验 1:1 带入初始金币');
      v_cnt := v_cnt + 1;
    end if;
  end loop;
  return v_cnt;
end;
$$;

-- 授权
grant execute on function public.keyflow_level_from_exp(bigint) to anon, authenticated;
grant execute on function public.keyflow_daily_coins(int) to anon, authenticated;
grant execute on function public.keyflow_coins_balance(uuid) to anon, authenticated;
grant execute on function public.keyflow_display_current_level(uuid, date) to anon, authenticated;
grant execute on function public.keyflow_answerer_exp(uuid) to anon, authenticated;
grant execute on function public.keyflow_answerer_economy_state(uuid) to anon, authenticated;
grant execute on function public.keyflow_apply_with_gate(uuid, uuid, text, text, text, text, int, text) to anon, authenticated;
grant execute on function public.keyflow_redeem_product(uuid, uuid, int, jsonb) to anon, authenticated;
grant execute on function public.keyflow_mark_answerer_active(uuid, date) to anon, authenticated;
grant execute on function public.keyflow_admin_adjust_coins(text, uuid, int, text) to anon, authenticated;
grant execute on function public.keyflow_admin_cancel_redeem(text, uuid) to anon, authenticated;
grant execute on function public.keyflow_admin_fulfill_redeem(text, uuid, jsonb) to anon, authenticated;
grant execute on function public.keyflow_grant_legacy_coins() to anon, authenticated;