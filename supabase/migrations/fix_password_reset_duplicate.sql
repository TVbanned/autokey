-- 修复：密码重置申请在“已通过(approved)”状态下的重复申请问题
-- 问题：答主提交申请后被管理员通过，但答主未及时设置新密码；此时若答主再次走“忘记密码”
--       并重新提交，RPC 只检查 status='pending'，会绕过已通过的申请再插入一条新的 pending，
--       导致管理员之前的“通过”被新申请覆盖，答主永远等不到进入“设置新密码”的状态。
-- 修复：申请函数额外阻止“已通过且在 30 分钟有效窗口内”的重复申请，并给出明确提示。

create or replace function public.keyflow_request_password_reset(p_answerer_id uuid)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_answerer record;
  v_existing uuid;
  v_inbox_id uuid;
  v_request_id uuid;
begin
  select id, zhihu_name into v_answerer from keyflow_answerers where id = p_answerer_id;
  if v_answerer.id is null then
    raise exception '答主不存在';
  end if;

  select id into v_existing from keyflow_password_reset_requests
  where answerer_id = p_answerer_id and status = 'pending';
  if v_existing is not null then
    raise exception '已有一个待处理的密码重置申请，请等待管理员审核';
  end if;

  select id into v_existing from keyflow_password_reset_requests
  where answerer_id = p_answerer_id and status = 'approved'
    and reviewed_at is not null and reviewed_at >= now() - interval '30 minutes';
  if v_existing is not null then
    raise exception '你的密码重置申请已通过审核，请直接设置新密码';
  end if;

  insert into keyflow_inbox (type, title, body, from_id, data)
  values ('password_reset', v_answerer.zhihu_name || ' · 密码重置申请',
    '答主 ' || v_answerer.zhihu_name || ' 申请重置登录密码，请审核。',
    p_answerer_id,
    jsonb_build_object('answerer_name', v_answerer.zhihu_name, 'answerer_id', p_answerer_id))
  returning id into v_inbox_id;

  insert into keyflow_password_reset_requests (answerer_id, inbox_id)
  values (p_answerer_id, v_inbox_id)
  returning id into v_request_id;

  return json_build_object('request_id', v_request_id, 'inbox_id', v_inbox_id, 'status', 'pending');
end;
$$;
grant execute on function public.keyflow_request_password_reset(uuid) to anon, authenticated;
