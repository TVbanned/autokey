-- 徽章图改为预生成静态图：新增 image_url 列 + 公开存储桶 + RPC 返回 image_url

alter table public.keyflow_badges
  add column if not exists image_url text not null default '';

-- 公开徽章图存储桶
insert into storage.buckets (id, name, public)
values ('badges', 'badges', true)
on conflict (id) do update set public = true;

-- RPC 返回 image_url
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
      'earned', (ub.id is not null),
      'awarded_at', ub.awarded_at
    ) order by (ub.id is not null) desc, ub.awarded_at desc nulls last, b.created_at desc)
    from public.keyflow_badges b
    left join public.keyflow_user_badges ub
      on ub.badge_id = b.id and ub.answerer_id = p_answerer_id
  ), '[]'::jsonb);
end;
$$;

grant execute on function public.keyflow_answerer_badges(uuid) to anon, authenticated;
