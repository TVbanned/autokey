-- 合作方登录保护：partner_answerer_id 关联 + 身份校验 RPC
alter table public.keyflow_activities
  add column if not exists partner_answerer_id uuid references public.keyflow_answerers(id);

create index if not exists keyflow_activities_partner_answerer_idx
  on public.keyflow_activities(partner_answerer_id);

-- 判断某答主是否为合作方（其邀请码 code_type = 'partner'）
create or replace function public.keyflow_is_partner(p_answerer_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  return exists (
    select 1 from keyflow_invitation_codes
    where answerer_id = p_answerer_id and code_type = 'partner'
  );
end;
$$;

grant execute on function public.keyflow_is_partner(uuid) to anon, authenticated;

-- 获取合作方关联的活动列表
create or replace function public.keyflow_get_partner_activities(p_answerer_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
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

-- 更新合作方活动快照：增加可选的身份校验
drop function if exists public.keyflow_partner_activity_snapshot(uuid);
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
begin
  select * into v_activity from keyflow_activities where partner_token = p_partner_token;
  if v_activity.id is null then
    raise exception '合作方页面不存在或已失效';
  end if;

  -- 如果传入了 answerer_id，校验该答主是否为合作方且关联了此活动
  if p_answerer_id is not null then
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
