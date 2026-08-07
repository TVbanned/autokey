-- 灰域信风（serial_number=1）在合作方页面可以看到所有已录入的活动（不仅是已关联合作方的）
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
