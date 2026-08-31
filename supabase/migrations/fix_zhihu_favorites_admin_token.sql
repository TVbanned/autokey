-- 收藏问题 RPC 兼容管理员 text session token（用户名、UUID 或 64 位 token）。

drop function if exists public.keyflow_admin_zhihu_question_favorites(uuid);
drop function if exists public.keyflow_admin_toggle_zhihu_question_favorite(uuid, text, text, text, boolean);

create or replace function public.keyflow_admin_zhihu_question_favorites(p_token text)
returns setof public.keyflow_zhihu_question_favorites
language plpgsql stable security definer set search_path = public
as $$
begin
  if not public.keyflow_is_admin(p_token) then
    raise exception '管理员权限不足';
  end if;

  return query
  select *
  from public.keyflow_zhihu_question_favorites
  order by created_at desc;
end;
$$;

create or replace function public.keyflow_admin_toggle_zhihu_question_favorite(
  p_token text,
  p_zhihu_url text,
  p_title text default '',
  p_source text default 'following',
  p_favorite boolean default true
)
returns public.keyflow_zhihu_question_favorites
language plpgsql security definer set search_path = public
as $$
declare
  result public.keyflow_zhihu_question_favorites;
begin
  if not public.keyflow_is_admin(p_token) then
    raise exception '管理员权限不足';
  end if;

  if p_favorite then
    insert into public.keyflow_zhihu_question_favorites (zhihu_url, title, source)
    values (
      split_part(trim(p_zhihu_url), '?', 1),
      trim(coalesce(p_title, '')),
      coalesce(nullif(trim(p_source), ''), 'following')
    )
    on conflict (zhihu_url) do update
      set title = excluded.title,
          source = excluded.source,
          updated_at = now()
    returning * into result;
  else
    delete from public.keyflow_zhihu_question_favorites
    where zhihu_url = split_part(trim(p_zhihu_url), '?', 1)
    returning * into result;
  end if;

  return result;
end;
$$;

revoke all on function public.keyflow_admin_zhihu_question_favorites(text) from public;
revoke all on function public.keyflow_admin_toggle_zhihu_question_favorite(text, text, text, text, boolean) from public;
grant execute on function public.keyflow_admin_zhihu_question_favorites(text) to anon;
grant execute on function public.keyflow_admin_toggle_zhihu_question_favorite(text, text, text, text, boolean) to anon;
