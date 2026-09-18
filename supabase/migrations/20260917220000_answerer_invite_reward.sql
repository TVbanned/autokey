-- 答主邀请奖励（2026-09-17）
--
-- 产品规则：
--   1) 答主用「分享邀请码」成功邀请新用户注册
--      （keyflow_invitation_codes.code_type = 'answerer_shared'，generated_by_answerer_id = 邀请人）；
--   2) 该新用户「成功投稿一条内容」后，邀请人获得 1500 金币；
--   3) 每个邀请人每自然月（北京时间）最多发放 3 次邀请奖励；
--   4) 同一个被邀请人只发一次，防止重复发放。
--
-- 「成功投稿一条内容」的口径：
--   该新用户在 keyflow_daily_submissions（日常投稿与综合活动投稿共用这张表）里，
--   有一条被后台标记「已处理（processed = true）」的投稿；投稿刚入库、后台还没处理时不发。
--
-- 默认值可以用 keyflow_economy_config 里 key = 'invite_reward' 的 json 覆盖：
--   { "coins": 1500, "monthly_cap": 3, "require_processed": true }
--
-- 验证逻辑全部在库里：投稿入库 / 被标记已处理时由触发器 keyflow_invite_reward_on_submission
-- 调 keyflow_settle_invite_reward()，由它校验邀请关系、投稿有效性、月度额度与幂等，
-- 全部通过才写 keyflow_coins_ledger（source = 'invite_reward'）和 keyflow_invite_rewards。

begin;

-- ---------- 1. 金币流水允许新增来源 invite_reward ----------
alter table public.keyflow_coins_ledger
  drop constraint if exists keyflow_coins_ledger_source_check;

alter table public.keyflow_coins_ledger
  add constraint keyflow_coins_ledger_source_check
  check (source in (
    'legacy_grant','daily_activity_reward','activity_reward',
    'admin_grant','admin_deduct','redeem','redeem_refund',
    'level_gate','level_gate_refund','invite_reward'));

-- ---------- 2. 邀请奖励发放记录 ----------
create table if not exists public.keyflow_invite_rewards (
  id uuid primary key default gen_random_uuid(),
  inviter_id uuid not null references public.keyflow_answerers(id) on delete cascade,
  invitee_id uuid not null unique references public.keyflow_answerers(id) on delete cascade,
  code_id uuid references public.keyflow_invitation_codes(id) on delete set null,
  code text not null default '',
  invitee_name text not null default '',
  coins integer not null check (coins > 0),
  trigger_submission_id uuid,
  trigger_kind text not null default 'daily_submission',
  reward_month date not null,
  ledger_id uuid references public.keyflow_coins_ledger(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists keyflow_invite_rewards_inviter_month_idx
  on public.keyflow_invite_rewards(inviter_id, reward_month);

alter table public.keyflow_invite_rewards enable row level security;
-- 不给 anon/authenticated 直接读写策略：只允许 security definer 函数写入、读接口走 RPC。

-- ---------- 3. 结算函数（幂等 + 月度额度 + 校验） ----------
create or replace function public.keyflow_settle_invite_reward(p_invitee_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_inviter_id uuid;
  v_code_id uuid;
  v_code text;
  v_invitee_name text;
  v_cfg jsonb;
  v_coins integer;
  v_cap integer;
  v_require_processed boolean;
  v_month date;
  v_used integer;
  v_hit_id uuid;
  v_reward_id uuid;
  v_ledger_id uuid;
begin
  if p_invitee_id is null then
    return jsonb_build_object('awarded', false, 'reason', 'no_invitee');
  end if;

  -- ① 找邀请人：用户注册时用的邀请码必须由答主生成
  select ic.id, ic.code, ic.generated_by_answerer_id, a.zhihu_name
    into v_code_id, v_code, v_inviter_id, v_invitee_name
  from public.keyflow_answerers a
  join public.keyflow_invitation_codes ic on ic.id = a.invitation_code_id
  where a.id = p_invitee_id
    and ic.code_type = 'answerer_shared'
    and ic.generated_by_answerer_id is not null;

  if v_inviter_id is null or v_inviter_id = p_invitee_id then
    return jsonb_build_object('awarded', false, 'reason', 'no_inviter');
  end if;

  -- ② 幂等：同一个被邀请人只发一次
  if exists (select 1 from public.keyflow_invite_rewards where invitee_id = p_invitee_id) then
    return jsonb_build_object('awarded', false, 'reason', 'already_rewarded');
  end if;

  -- ③ 规则参数（可在 keyflow_economy_config 里用 key='invite_reward' 覆盖）
  v_cfg := coalesce((select value from public.keyflow_economy_config where key = 'invite_reward'), '{}'::jsonb);
  v_coins := coalesce(nullif(v_cfg ->> 'coins', '')::integer, 1500);
  v_cap := coalesce(nullif(v_cfg ->> 'monthly_cap', '')::integer, 3);
  v_require_processed := coalesce((v_cfg ->> 'require_processed')::boolean, true);
  if v_coins <= 0 or v_cap <= 0 then
    return jsonb_build_object('awarded', false, 'reason', 'disabled');
  end if;

  -- ④ 有效投稿校验：该新用户至少有一条（默认要求后台已处理）投稿
  select s.id into v_hit_id
  from public.keyflow_daily_submissions s
  where s.answerer_id = p_invitee_id
    and (not v_require_processed or coalesce(s.processed, false))
  order by s.created_at
  limit 1;

  if v_hit_id is null then
    return jsonb_build_object('awarded', false, 'reason', 'no_valid_submission');
  end if;

  v_month := date_trunc('month', (now() at time zone 'Asia/Shanghai'))::date;

  -- ⑤ 同一邀请人的并发结算串行化
  perform pg_advisory_xact_lock(hashtext('invite_reward:' || v_inviter_id::text));

  -- ⑥ 本月额度
  select count(*) into v_used
  from public.keyflow_invite_rewards
  where inviter_id = v_inviter_id and reward_month = v_month;

  if v_used >= v_cap then
    return jsonb_build_object('awarded', false, 'reason', 'monthly_cap', 'used', v_used, 'cap', v_cap);
  end if;

  -- ⑦ 发奖：先写发放记录拿 id，再写金币流水（ref_id 指回发放记录）
  insert into public.keyflow_invite_rewards (
    inviter_id, invitee_id, code_id, code, invitee_name, coins,
    trigger_submission_id, trigger_kind, reward_month
  ) values (
    v_inviter_id, p_invitee_id, v_code_id, coalesce(v_code, ''), coalesce(v_invitee_name, ''), v_coins,
    v_hit_id, 'daily_submission', v_month
  )
  on conflict (invitee_id) do nothing
  returning id into v_reward_id;

  if v_reward_id is null then
    return jsonb_build_object('awarded', false, 'reason', 'already_rewarded');
  end if;

  insert into public.keyflow_coins_ledger (answerer_id, amount, source, ref_id, note)
  values (
    v_inviter_id, v_coins, 'invite_reward', v_reward_id,
    '邀请奖励：' || coalesce(v_code, '') || ' → ' || coalesce(v_invitee_name, '') || ' 已成功投稿'
  )
  returning id into v_ledger_id;

  update public.keyflow_invite_rewards set ledger_id = v_ledger_id where id = v_reward_id;

  return jsonb_build_object(
    'awarded', true, 'coins', v_coins, 'inviter_id', v_inviter_id,
    'invitee_id', p_invitee_id, 'reward_id', v_reward_id, 'month', v_month);
end;
$$;

-- 只允许触发器/后台调用，不给前端直接调
revoke all on function public.keyflow_settle_invite_reward(uuid) from public, anon, authenticated;

-- ---------- 4. 触发器：投稿入库 / 被标记已处理时结算 ----------
create or replace function public.keyflow_invite_reward_on_submission()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- 奖励结算出任何问题都不能影响答主正常投稿，所以整段兜底吞掉异常
  begin
    if tg_op = 'INSERT' then
      perform public.keyflow_settle_invite_reward(new.answerer_id);
    elsif tg_op = 'UPDATE' then
      if coalesce(new.processed, false) and not coalesce(old.processed, false) then
        perform public.keyflow_settle_invite_reward(new.answerer_id);
      end if;
    end if;
  exception when others then
    null;
  end;
  return null;
end;
$$;

revoke all on function public.keyflow_invite_reward_on_submission() from public, anon, authenticated;

drop trigger if exists trg_invite_reward_on_daily_submission on public.keyflow_daily_submissions;
create trigger trg_invite_reward_on_daily_submission
  after insert or update on public.keyflow_daily_submissions
  for each row execute function public.keyflow_invite_reward_on_submission();

-- ---------- 5. 答主看板「邀请码」页的进度读接口 ----------
create or replace function public.keyflow_answerer_invite_state(p_answerer_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_cfg jsonb;
  v_coins integer;
  v_cap integer;
  v_month date := date_trunc('month', (now() at time zone 'Asia/Shanghai'))::date;
  v_rewarded_month integer := 0;
  v_rewarded_total integer := 0;
  v_coins_total bigint := 0;
  v_invited_total integer := 0;
begin
  v_cfg := coalesce((select value from public.keyflow_economy_config where key = 'invite_reward'), '{}'::jsonb);
  v_coins := coalesce(nullif(v_cfg ->> 'coins', '')::integer, 1500);
  v_cap := coalesce(nullif(v_cfg ->> 'monthly_cap', '')::integer, 3);

  select count(*), coalesce(sum(coins), 0)
    into v_rewarded_total, v_coins_total
  from public.keyflow_invite_rewards
  where inviter_id = p_answerer_id;

  select count(*) into v_rewarded_month
  from public.keyflow_invite_rewards
  where inviter_id = p_answerer_id and reward_month = v_month;

  select count(*) into v_invited_total
  from public.keyflow_invitation_codes
  where generated_by_answerer_id = p_answerer_id and answerer_id is not null;

  return jsonb_build_object(
    'month', to_char(v_month, 'YYYY-MM'),
    'coins_per_invite', v_coins,
    'monthly_cap', v_cap,
    'rewarded_this_month', v_rewarded_month,
    'slots_left_this_month', greatest(0, v_cap - v_rewarded_month),
    'rewarded_total', v_rewarded_total,
    'coins_total', v_coins_total,
    'invited_total', v_invited_total,
    -- 已用你的邀请码注册、但还没发到奖的人（还在等首条投稿被后台确认）
    'pending_invitees', greatest(0, v_invited_total - v_rewarded_total),
    'rewards_this_month', coalesce((
      select jsonb_agg(jsonb_build_object(
        'invitee_name', invitee_name,
        'coins', coins,
        'at', to_char((created_at at time zone 'Asia/Shanghai'), 'MM-DD HH24:MI'))
        order by created_at)
      from public.keyflow_invite_rewards
      where inviter_id = p_answerer_id and reward_month = v_month), '[]'::jsonb)
  );
end;
$$;

grant execute on function public.keyflow_answerer_invite_state(uuid) to anon, authenticated;

commit;
