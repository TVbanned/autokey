-- 密码重置安全加固：
-- 1) 审核函数增加管理员鉴权，防止 anon 越权通过/拒绝申请
-- 2) 设置新密码增加审批时间窗（30 分钟内有效），缩短被抢注的窗口

-- ============ 1. 审核函数鉴权 ============
-- 删除旧的无鉴权签名（uuid 请求id, boolean, text）
drop function if exists public.keyflow_review_password_reset(uuid, boolean, text);
drop function if exists public.keyflow_review_password_reset(uuid, boolean);

create or replace function public.keyflow_review_password_reset(
  p_token uuid,
  p_request_id uuid,
  p_approved boolean,
  p_note text default ''
)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_request record;
begin
  if not public.keyflow_is_admin(p_token) then
    raise exception '管理员权限不足';
  end if;

  select * into v_request from keyflow_password_reset_requests where id = p_request_id;
  if v_request.id is null then
    raise exception '申请不存在';
  end if;
  if v_request.status != 'pending' then
    raise exception '该申请已被处理';
  end if;

  update keyflow_password_reset_requests
  set status = case when p_approved then 'approved' else 'rejected' end,
      admin_note = p_note,
      reviewed_at = now()
  where id = p_request_id;

  update keyflow_inbox set status = 'read', read_at = now()
  where id = v_request.inbox_id;

  return json_build_object(
    'request_id', p_request_id,
    'status', case when p_approved then 'approved' else 'rejected' end
  );
end;
$$;

grant execute on function public.keyflow_review_password_reset(uuid, uuid, boolean, text) to anon, authenticated;

-- ============ 2. 设置新密码加审批时间窗 ============
create or replace function public.keyflow_reset_password(
  p_answerer_id uuid,
  p_new_password text
)
returns json
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_request record;
begin
  select * into v_request from keyflow_password_reset_requests
  where answerer_id = p_answerer_id and status = 'approved'
  order by reviewed_at desc limit 1;

  if v_request.id is null then
    raise exception '未找到已批准的密码重置申请';
  end if;

  if v_request.reviewed_at is null or v_request.reviewed_at < now() - interval '30 minutes' then
    raise exception '审批已过期，请重新提交密码重置申请';
  end if;

  update keyflow_answerers
  set password_hash = crypt(p_new_password, gen_salt('bf')), updated_at = now()
  where id = p_answerer_id;

  update keyflow_password_reset_requests
  set status = 'completed', completed_at = now()
  where id = v_request.id;

  return json_build_object('success', true);
end;
$$;

grant execute on function public.keyflow_reset_password(uuid, text) to anon, authenticated;
