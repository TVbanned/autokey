-- 同一活动在“正在参与”时，不能同时出现在“历史活动”。
alter function public.keyflow_answerer_dashboard(uuid)
rename to keyflow_answerer_dashboard_raw;

create function public.keyflow_answerer_dashboard(p_answerer_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_dashboard jsonb;
begin
  select public.keyflow_answerer_dashboard_raw(p_answerer_id) into v_dashboard;

  return jsonb_set(
    v_dashboard,
    '{historical_activities}',
    coalesce((
      select jsonb_agg(history_item)
      from jsonb_array_elements(coalesce(v_dashboard->'historical_activities', '[]'::jsonb)) history_item
      where not exists (
        select 1
        from jsonb_array_elements(coalesce(v_dashboard->'activities', '[]'::jsonb)) ongoing_item
        where ongoing_item->>'id' = history_item->>'id'
      )
    ), '[]'::jsonb)
  );
end;
$$;

grant execute on function public.keyflow_answerer_dashboard(uuid) to anon, authenticated;
revoke all on function public.keyflow_answerer_dashboard_raw(uuid) from public, anon, authenticated;
