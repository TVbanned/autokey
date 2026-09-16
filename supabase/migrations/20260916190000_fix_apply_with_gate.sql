-- 修复「等级门槛 + 金币补足」自助报名 RPC（2026-09-16）：
--   1) 原函数 insert 时写了 keyflow_applications.zhihu_id —— 该列早已不存在，调用必报
--      `column "zhihu_id" of relation "keyflow_applications" does not exist`，等于这条链路一直没通。
--   2) 已有报名时不重复插入（表上有 activity_id + answerer_id 唯一约束），改为复用并更新资料；
--      如果旧报名的补足款已退回（没有生效中的 gate_payments），重新报名会重新收费。
--   3) 返回体补齐 level / min_level / charged / reused，便于前端展示与提示。
--   注意：wechat_name / profile_url / expected_word_count 是 NOT NULL，必须兜底。

begin;

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
  v_fee int := 0;
  v_balance bigint;
  v_app uuid;
  v_existing uuid;
  v_charged boolean := false;
begin
  select min_level, coin_gate_enabled, coin_per_level into v_act
  from public.keyflow_activities where id = p_activity_id;
  if not found then raise exception '活动不存在'; end if;

  if not exists (select 1 from public.keyflow_answerers where id = p_answerer_id) then
    raise exception '答主不存在';
  end if;

  v_cur := public.keyflow_display_current_level(p_answerer_id, (now() at time zone 'Asia/Shanghai')::date);
  v_gap := greatest(0, coalesce(v_act.min_level, 0) - v_cur);

  select id into v_existing
  from public.keyflow_applications
  where activity_id = p_activity_id and answerer_id = p_answerer_id;

  if v_gap > 0 then
    if not coalesce(v_act.coin_gate_enabled, false) then
      raise exception '该活动要求 Lv%，当前等级不足', v_act.min_level;
    end if;
    -- 已经有生效中的补足记录就不再重复扣费（例如再次提交同一活动）
    if v_existing is null or not exists (
      select 1 from public.keyflow_gate_payments g
      where g.application_id = v_existing and g.status = 'paid'
    ) then
      v_fee := v_gap * coalesce(v_act.coin_per_level, 800);
      v_balance := public.keyflow_coins_balance(p_answerer_id);
      if v_balance < v_fee then
        raise exception '金币不足：需 % 金币补足 % 级门槛（当前余额 %）', v_fee, v_gap, v_balance;
      end if;
    end if;
  end if;

  if v_existing is not null then
    update public.keyflow_applications
       set zhihu_name = coalesce(nullif(trim(coalesce(p_zhihu_name, '')), ''), zhihu_name),
           wechat_name = coalesce(nullif(trim(coalesce(p_wechat_name, '')), ''), wechat_name),
           profile_url = coalesce(nullif(trim(coalesce(p_profile_url, '')), ''), profile_url),
           expected_word_count = greatest(800, coalesce(p_expected_word_count, 800)),
           selected_platform = coalesce(nullif(trim(coalesce(p_selected_platform, '')), ''), selected_platform)
     where id = v_existing;
    v_app := v_existing;
  else
    insert into public.keyflow_applications
      (activity_id, zhihu_name, wechat_name, profile_url, expected_word_count, selected_platform, answerer_id, status)
    values (
      p_activity_id,
      coalesce(nullif(trim(coalesce(p_zhihu_name, '')), ''), '未填写'),
      coalesce(trim(coalesce(p_wechat_name, '')), ''),
      coalesce(trim(coalesce(p_profile_url, '')), ''),
      greatest(800, coalesce(p_expected_word_count, 800)),
      coalesce(nullif(trim(coalesce(p_selected_platform, '')), ''), 'steam'),
      p_answerer_id,
      'pending'
    )
    returning id into v_app;
  end if;

  if v_fee > 0 then
    insert into public.keyflow_coins_ledger (answerer_id, amount, source, ref_id, note)
    values (p_answerer_id, -v_fee, 'level_gate', v_app, '补足 Lv' || v_cur || '→' || v_act.min_level || ' 门槛');
    -- 一条报名只保留一条补足记录（表上有 application_id 唯一约束）：
    -- 被拒退款后重新报名时复用同一行，恢复成 paid。
    insert into public.keyflow_gate_payments (application_id, answerer_id, activity_id, level_gap, coins_paid)
    values (v_app, p_answerer_id, p_activity_id, v_gap, v_fee)
    on conflict (application_id) do update
      set level_gap = excluded.level_gap,
          coins_paid = excluded.coins_paid,
          status = 'paid',
          paid_at = now(),
          refunded_at = null;
    v_charged := true;
  end if;

  perform public.keyflow_mark_answerer_active(p_answerer_id);

  return jsonb_build_object(
    'application_id', v_app,
    'gate_gap', v_gap,
    'gate_fee', v_fee,
    'charged', v_charged,
    'reused', v_existing is not null,
    'level', v_cur,
    'min_level', coalesce(v_act.min_level, 0)
  );
end;
$$;

grant execute on function public.keyflow_apply_with_gate(uuid, uuid, text, text, text, text, int, text) to anon, authenticated;

commit;
