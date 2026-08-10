-- 合作方活动列表增加报名人数和领取key人数
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
        'delivery_deadline', a.delivery_deadline,
        'application_count', (select count(*) from keyflow_applications where activity_id = a.id),
        'key_claimed_count', (select count(*) from keyflow_applications app join keyflow_keys k on k.application_id = app.id where app.activity_id = a.id and app.status = 'selected' and k.claimed_at is not null)
      ) order by a.created_at desc
    )
    from keyflow_activities a
    where a.partner_answerer_id = p_answerer_id
  ), '[]'::jsonb);
end;
$$;

grant execute on function public.keyflow_get_partner_activities(uuid) to anon, authenticated;
