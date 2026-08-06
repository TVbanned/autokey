-- ponytail: partner snapshot was missing activity.id, so the claim-page link was always ?apply=undefined
create or replace function public.keyflow_partner_activity_snapshot(p_partner_token uuid)
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

  return jsonb_build_object(
    'activity', jsonb_build_object('id', v_activity.id, 'title', v_activity.title, 'game_name', v_activity.game_name, 'game_cover', v_activity.game_cover, 'application_deadline', v_activity.application_deadline, 'delivery_deadline', v_activity.delivery_deadline),
    'applications', coalesce((select jsonb_agg(jsonb_build_object('zhihu_name', a.zhihu_name, 'status', a.status, 'submitted_at', a.submitted_at) order by a.submitted_at desc) from keyflow_applications a where a.activity_id = v_activity.id), '[]'::jsonb),
    'deliveries', coalesce((select jsonb_agg(jsonb_build_object('zhihu_name', a.zhihu_name, 'status', d.status, 'article_url', d.article_url, 'submitted_at', d.submitted_at) order by d.submitted_at desc) from keyflow_deliveries d join keyflow_applications a on a.id = d.application_id where a.activity_id = v_activity.id), '[]'::jsonb),
    'key_count', (select count(*) from keyflow_keys where activity_id = v_activity.id)
  );
end;
$$;

grant execute on function public.keyflow_partner_activity_snapshot(uuid) to anon, authenticated;
