-- 答主看板徽章仅返回「已获得」的徽章（不再返回未解锁徽章）

create or replace function public.keyflow_answerer_badges(p_answerer_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'game_name', b.game_name,
      'name', b.name,
      'image_url', b.image_url,
      'awarded_at', ub.awarded_at
    ) order by ub.awarded_at desc)
    from public.keyflow_user_badges ub
    join public.keyflow_badges b on b.id = ub.badge_id
    where ub.answerer_id = p_answerer_id
  ), '[]'::jsonb);
end;
$$;

grant execute on function public.keyflow_answerer_badges(uuid) to anon, authenticated;
