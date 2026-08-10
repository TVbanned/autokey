-- 合作方审核交付作品：通过 / 不通过

-- 1. 更新 snapshot，返回 delivery id
drop function if exists public.keyflow_partner_activity_snapshot(uuid, uuid);
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
        'id', d.id,
        'zhihu_name', a.zhihu_name,
        'status', d.status,
        'article_url', d.article_url,
        'article_title', d.article_title,
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

-- 2. 合作方审核交付
create or replace function public.keyflow_partner_review_delivery(
  p_partner_token uuid,
  p_delivery_id uuid,
  p_status text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_activity_id uuid;
begin
  select id into v_activity_id from keyflow_activities where partner_token = p_partner_token;
  if v_activity_id is null then
    raise exception '合作方页面不存在或已失效';
  end if;

  if p_status not in ('approved', 'rejected') then
    raise exception '无效的审核状态';
  end if;

  update keyflow_deliveries
  set status = p_status,
      reviewer_note = case when p_status = 'approved' then '合作方通过' else '合作方不通过' end,
      reviewed_at = now()
  where id = p_delivery_id
    and application_id in (
      select id from keyflow_applications where activity_id = v_activity_id
    );

  if not found then
    raise exception '交付记录不存在或不属于该活动';
  end if;
end;
$$;

grant execute on function public.keyflow_partner_review_delivery(uuid, uuid, text) to anon, authenticated;
