-- 邀请码已全局化，keyflow_register_with_code 不再按 activity_id 查邀请码
create or replace function public.keyflow_register_with_code(
  p_activity_id uuid,
  p_code text,
  p_zhihu_name text,
  p_wechat_name text,
  p_profile_url text,
  p_expected_word_count integer
)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_code_id uuid;
  v_app_id uuid;
  v_app record;
begin
  -- 原子检查并锁定邀请码（不再按 activity_id 过滤）
  select id into v_code_id
  from keyflow_invitation_codes
  where upper(code) = upper(p_code)
    and application_id is null
    and answerer_id is null
  for update skip locked;

  if v_code_id is null then
    raise exception '邀请码无效或已被使用';
  end if;

  -- 创建报名
  insert into keyflow_applications (
    activity_id, zhihu_name, wechat_name, profile_url,
    expected_word_count, status
  ) values (
    p_activity_id, p_zhihu_name, p_wechat_name, p_profile_url,
    greatest(p_expected_word_count, 800), 'pending'
  ) returning id into v_app_id;

  -- 绑定邀请码
  update keyflow_invitation_codes
  set application_id = v_app_id, used_at = now()
  where id = v_code_id;

  select a.id, a.activity_id, a.zhihu_name, a.wechat_name, a.profile_url,
         a.expected_word_count, a.status, a.submitted_at, a.reviewer_note,
         a.zhihu_id, a.delayed_count
  into v_app
  from keyflow_applications a where a.id = v_app_id;

  return row_to_json(v_app);
end;
$$;

grant execute on function public.keyflow_register_with_code(uuid, text, text, text, text, integer) to anon, authenticated;
