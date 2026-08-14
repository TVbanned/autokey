-- 合并修复：合作方活动列表同时保留“灰域信风(serial_number=1)超级管理员可见全部活动”的能力，
-- 并在返回结果中补齐 application_count（报名人数）与 key_claimed_count（已领取 key 人数）。
-- 之前 add_partner_activity_counts.sql 只加了计数但丢掉了超级管理员分支，
-- 之后又被 fix_super_admin_see_all_activities.sql / add_super_admin_partner_bypass.sql 覆盖，导致线上计数为 0。

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
          'delivery_deadline', a.delivery_deadline,
          'application_count', (select count(*) from keyflow_applications where activity_id = a.id),
          'key_claimed_count', (
            select count(*)
            from keyflow_applications app
            join keyflow_keys k on k.application_id = app.id
            where app.activity_id = a.id
              and app.status = 'selected'
              and k.claimed_at is not null
          )
        ) order by a.created_at desc
      )
      from keyflow_activities a
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
        'delivery_deadline', a.delivery_deadline,
        'application_count', (select count(*) from keyflow_applications where activity_id = a.id),
        'key_claimed_count', (
          select count(*)
          from keyflow_applications app
          join keyflow_keys k on k.application_id = app.id
          where app.activity_id = a.id
            and app.status = 'selected'
            and k.claimed_at is not null
        )
      ) order by a.created_at desc
    )
    from keyflow_activities a
    where a.partner_answerer_id = p_answerer_id
  ), '[]'::jsonb);
end;
$$;

grant execute on function public.keyflow_get_partner_activities(uuid) to anon, authenticated;
