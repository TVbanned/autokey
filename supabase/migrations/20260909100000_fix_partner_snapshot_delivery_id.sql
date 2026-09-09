-- 修复：合作方协作页快照的 deliveries 聚合漏掉了 id（及 article_title）。
-- 前端“通过/不通过”按钮依赖 item.id 作为 keyflow_partner_review_delivery 的 p_delivery_id，
-- id 缺失时该参数被丢弃，PostgREST 报 PGRST202（找不到 (p_partner_token, p_status) 签名）。
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
      'delivery_deadline', v_activity.delivery_deadline,
      'platforms', v_activity.platforms
    ),
    'applications', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', a.id,
        'zhihu_name', a.zhihu_name,
        'profile_url', a.profile_url,
        'expected_word_count', a.expected_word_count,
        'status', a.status,
        'partner_recommended', a.partner_recommended,
        'submitted_at', a.submitted_at,
        'selected_platform', a.selected_platform
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
