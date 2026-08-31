-- 日常问题表已使用 (zhihu_url, content_type) 联合唯一约束；管理员写入 RPC 必须使用相同冲突目标。
create or replace function public.keyflow_admin_create_daily_questions(
  p_token text,
  p_questions jsonb
)
returns setof public.keyflow_daily_questions
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.keyflow_is_admin(p_token) then
    raise exception '管理员权限不足';
  end if;

  return query
  insert into public.keyflow_daily_questions (title, zhihu_url, content_type)
  select
    trim(item->>'title'),
    split_part(trim(item->>'zhihu_url'), '?', 1),
    case
      when trim(item->>'content_type') in ('answer', 'question') then trim(item->>'content_type')
      when split_part(trim(item->>'zhihu_url'), '?', 1) ~ '/answer/\\d+' then 'answer'
      else 'question'
    end
  from jsonb_array_elements(coalesce(p_questions, '[]'::jsonb)) item
  where trim(coalesce(item->>'title', '')) <> ''
    and trim(coalesce(item->>'zhihu_url', '')) ~* '^https?://(www[.])?zhihu[.]com/'
  on conflict (zhihu_url, content_type) do update
  set title = excluded.title,
      updated_at = now()
  returning *;
end;
$$;

revoke all on function public.keyflow_admin_create_daily_questions(text, jsonb) from public;
grant execute on function public.keyflow_admin_create_daily_questions(text, jsonb) to anon;
