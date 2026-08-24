-- 答主看板「今日提问投稿」：答主投递的问题写入日常问题&回答运营表。
-- answerer_id 记录投稿人（管理员粘贴的条目保持 NULL）。

alter table public.keyflow_daily_questions
  add column if not exists answerer_id uuid references public.keyflow_answerers(id);

drop function if exists public.keyflow_answerer_create_daily_questions(uuid, jsonb);
create or replace function public.keyflow_answerer_create_daily_questions(
  p_answerer_id uuid,
  p_questions jsonb
)
returns setof public.keyflow_daily_questions
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (select 1 from public.keyflow_answerers where id = p_answerer_id) then
    raise exception '答主不存在';
  end if;

  return query
  insert into public.keyflow_daily_questions (title, zhihu_url, content_type, answerer_id)
  select trim(item->>'title'),
         split_part(trim(item->>'zhihu_url'), '?', 1),
         case
           when trim(item->>'content_type') in ('answer', 'question') then trim(item->>'content_type')
           when split_part(trim(item->>'zhihu_url'), '?', 1) ~ '/answer/\d+' then 'answer'
           else 'question'
         end,
         p_answerer_id
  from jsonb_array_elements(coalesce(p_questions, '[]'::jsonb)) item
  where trim(coalesce(item->>'title', '')) <> ''
    and trim(coalesce(item->>'zhihu_url', '')) ~* '^https?://(www[.])?zhihu[.]com/'
  on conflict (zhihu_url, content_type) do update
    set updated_at = now()
  returning *;
end;
$$;

revoke all on function public.keyflow_answerer_create_daily_questions(uuid, jsonb) from public;
grant execute on function public.keyflow_answerer_create_daily_questions(uuid, jsonb) to anon;
