-- 批量收藏问题 RPC + 答主看板收藏展示上限 20 条。
create or replace function public.keyflow_admin_batch_favorite_zhihu_questions(
  p_token text,
  p_items jsonb,
  p_source text default 'following',
  p_favorite boolean default true
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer := 0;
  v_item jsonb;
  v_url text;
  v_title text;
begin
  if not public.keyflow_is_admin(p_token) then
    raise exception '管理员权限不足';
  end if;

  for v_item in select * from jsonb_array_elements(coalesce(p_items, '[]'::jsonb))
  loop
    v_url := split_part(trim(coalesce(v_item->>'zhihu_url', '')), '?', 1);
    if v_url = '' then
      continue;
    end if;
    v_title := trim(coalesce(v_item->>'title', ''));

    if p_favorite then
      insert into public.keyflow_zhihu_question_favorites (zhihu_url, title, source)
      values (v_url, v_title, coalesce(nullif(trim(p_source), ''), 'following'))
      on conflict (zhihu_url) do update
        set title = excluded.title,
            source = excluded.source,
            updated_at = now();
    else
      delete from public.keyflow_zhihu_question_favorites
      where zhihu_url = v_url;
    end if;
    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$$;

-- 答主看板仅展示最近收藏的 20 条
create or replace function public.keyflow_answerer_zhihu_question_favorites(p_answerer_id uuid)
returns setof public.keyflow_zhihu_question_favorites
language sql stable security definer set search_path = public
as $$
  select *
  from public.keyflow_zhihu_question_favorites
  order by created_at desc
  limit 20;
$$;

revoke all on function public.keyflow_admin_batch_favorite_zhihu_questions(text, jsonb, text, boolean) from public;
grant execute on function public.keyflow_admin_batch_favorite_zhihu_questions(text, jsonb, text, boolean) to anon;
