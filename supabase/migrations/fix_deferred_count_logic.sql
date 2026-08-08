-- 修正延期答主计数逻辑：同时满足「被选入延期答主」+「活动完结后提交测评」才计入一次延期
create or replace function public.keyflow_get_author_delayed_count(p_zhihu_id text)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
begin
  select count(*)::integer into v_count
  from keyflow_deliveries d
  join keyflow_applications a on d.application_id = a.id
  join keyflow_activities act on a.activity_id = act.id
  where a.zhihu_id = p_zhihu_id
    and act.status = 'completed'
    and act.deferred_answerer_ids @> to_jsonb(a.answerer_id::text);
  return coalesce(v_count, 0);
end;
$$;

grant execute on function public.keyflow_get_author_delayed_count(text) to anon, authenticated;
