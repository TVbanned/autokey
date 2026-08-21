-- ponytail: 提供标记手动领取的 security definer RPC。
-- keyflow_keys 只有 select 策略，前端直接 update claimed_at 会被 RLS 拦截，
-- 导致手动领取从未真正落库。这里用 security definer 函数绕过 RLS 完成标记。

create or replace function public.keyflow_mark_key_claimed(p_key_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_claimed_at timestamptz;
begin
  update keyflow_keys
  set claimed_at = now()
  where id = p_key_id
    and application_id is null
  returning claimed_at into v_claimed_at;

  if v_claimed_at is null then
    raise exception 'Key 不存在或已被答主领取';
  end if;

  return jsonb_build_object('id', p_key_id, 'claimed_at', v_claimed_at);
end;
$$;

grant execute on function public.keyflow_mark_key_claimed(uuid) to anon, authenticated;
