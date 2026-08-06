-- 添加合作方推荐字段 + 更新 snapshot 返回更多报名信息 + toggle recommend RPC

-- 1. 新增 partner_recommended 列
alter table public.keyflow_applications
  add column if not exists partner_recommended boolean not null default false;

-- 2. 更新 partner snapshot，返回 id、profile_url、expected_word_count、partner_recommended
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
    'applications', coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'zhihu_name', a.zhihu_name, 'profile_url', a.profile_url, 'expected_word_count', a.expected_word_count, 'partner_recommended', a.partner_recommended, 'status', a.status, 'submitted_at', a.submitted_at) order by a.submitted_at desc) from keyflow_applications a where a.activity_id = v_activity.id), '[]'::jsonb),
    'deliveries', coalesce((select jsonb_agg(jsonb_build_object('zhihu_name', a.zhihu_name, 'status', d.status, 'article_url', d.article_url, 'submitted_at', d.submitted_at) order by d.submitted_at desc) from keyflow_deliveries d join keyflow_applications a on a.id = d.application_id where a.activity_id = v_activity.id), '[]'::jsonb),
    'key_count', (select count(*) from keyflow_keys where activity_id = v_activity.id)
  );
end;
$$;

grant execute on function public.keyflow_partner_activity_snapshot(uuid) to anon, authenticated;

-- 3. 合作方切换推荐状态
create or replace function public.keyflow_partner_toggle_recommend(p_partner_token uuid, p_application_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_activity_id uuid;
  v_current boolean;
begin
  select id into v_activity_id from keyflow_activities where partner_token = p_partner_token;
  if v_activity_id is null then
    raise exception '合作方页面不存在或已失效';
  end if;

  select partner_recommended into v_current
  from keyflow_applications
  where id = p_application_id and activity_id = v_activity_id;

  if not found then
    raise exception '报名记录不存在';
  end if;

  update keyflow_applications
  set partner_recommended = not v_current
  where id = p_application_id;

  return not v_current;
end;
$$;

grant execute on function public.keyflow_partner_toggle_recommend(uuid, uuid) to anon, authenticated;
