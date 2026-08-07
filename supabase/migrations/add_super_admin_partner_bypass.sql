-- 灰域信风（serial_number=1）作为超级管理员，拥有合作方全部权限
-- 修改三个合作方 RPC 使其对 serial_number=1 的答主放行全部活动

-- 1. keyflow_is_partner：序列号 1 始终返回 true
create or replace function public.keyflow_is_partner(p_answerer_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  if exists (select 1 from keyflow_answerers where id = p_answerer_id and serial_number = 1) then
    return true;
  end if;
  return exists (
    select 1 from keyflow_invitation_codes
    where answerer_id = p_answerer_id and code_type = 'partner'
  );
end;
$$;

grant execute on function public.keyflow_is_partner(uuid) to anon, authenticated;

-- 2. keyflow_get_partner_activities：序列号 1 返回全部已关联合作方的活动
create or replace function public.keyflow_get_partner_activities(p_answerer_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  if exists (select 1 from keyflow_answerers where id = p_answerer_id and serial_number = 1) then
    return coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id', a.id,
          'title', a.title,
          'game_name', a.game_name,
          'game_cover', a.game_cover,
          'partner_token', a.partner_token,
          'status', a.status,
          'application_deadline', a.application_deadline,
          'delivery_deadline', a.delivery_deadline
        ) order by a.created_at desc
      )
      from keyflow_activities a
      where a.partner_answerer_id is not null
    ), '[]'::jsonb);
  end if;
  return coalesce((
    select jsonb_agg(
      jsonb_build_object(
        'id', a.id,
        'title', a.title,
        'game_name', a.game_name,
        'game_cover', a.game_cover,
        'partner_token', a.partner_token,
        'status', a.status,
        'application_deadline', a.application_deadline,
        'delivery_deadline', a.delivery_deadline
      ) order by a.created_at desc
    )
    from keyflow_activities a
    where a.partner_answerer_id = p_answerer_id
  ), '[]'::jsonb);
end;
$$;

grant execute on function public.keyflow_get_partner_activities(uuid) to anon, authenticated;

-- 3. keyflow_partner_activity_snapshot：序列号 1 跳过合作方身份与活动归属校验
create or replace function public.keyflow_partner_activity_snapshot(
  p_partner_token uuid,
  p_answerer_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_activity keyflow_activities;
  v_is_super_admin boolean;
begin
  select * into v_activity from keyflow_activities where partner_token = p_partner_token;
  if v_activity.id is null then
    raise exception '合作方页面不存在或已失效';
  end if;

  if p_answerer_id is not null then
    select exists (select 1 from keyflow_answerers where id = p_answerer_id and serial_number = 1) into v_is_super_admin;
    if not v_is_super_admin then
      if not exists (
        select 1 from keyflow_invitation_codes
        where answerer_id = p_answerer_id and code_type = 'partner'
      ) then
        raise exception '你当前不是合作方身份，无法访问此页面';
      end if;
      if v_activity.partner_answerer_id is not null and v_activity.partner_answerer_id <> p_answerer_id then
        raise exception '你无权访问此活动的协作页';
      end if;
    end if;
  end if;

  return jsonb_build_object(
    'activity', jsonb_build_object(
      'id', v_activity.id,
      'title', v_activity.title,
      'game_name', v_activity.game_name,
      'game_cover', v_activity.game_cover,
      'application_deadline', v_activity.application_deadline,
      'delivery_deadline', v_activity.delivery_deadline
    ),
    'applications', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', a.id,
        'zhihu_name', a.zhihu_name,
        'profile_url', a.profile_url,
        'expected_word_count', a.expected_word_count,
        'status', a.status,
        'partner_recommended', a.partner_recommended,
        'submitted_at', a.submitted_at
      ) order by a.submitted_at desc)
      from keyflow_applications a where a.activity_id = v_activity.id
    ), '[]'::jsonb),
    'deliveries', coalesce((
      select jsonb_agg(jsonb_build_object(
        'zhihu_name', a.zhihu_name,
        'status', d.status,
        'article_url', d.article_url,
        'submitted_at', d.submitted_at
      ) order by d.submitted_at desc)
      from keyflow_deliveries d
      join keyflow_applications a on a.id = d.application_id
      where a.activity_id = v_activity.id
    ), '[]'::jsonb),
    'key_count', (select count(*) from keyflow_keys where activity_id = v_activity.id)
  );
end;
$$;

grant execute on function public.keyflow_partner_activity_snapshot(uuid, uuid) to anon, authenticated;
