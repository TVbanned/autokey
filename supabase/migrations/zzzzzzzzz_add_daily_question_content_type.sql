-- 日常问题&回答运营：新增 content_type 区分「问题 question」与「回答 answer」。
-- 唯一约束由 (zhihu_url) 调整为 (zhihu_url, content_type)，允许同一链接分别作为问题与回答各存一条。

alter table public.keyflow_daily_questions
  add column if not exists content_type text not null default 'question';

alter table public.keyflow_daily_questions
  drop constraint if exists keyflow_daily_questions_zhihu_url_key;

alter table public.keyflow_daily_questions
  add constraint keyflow_daily_questions_zhihu_url_key unique (zhihu_url, content_type);

alter table public.keyflow_daily_questions
  drop constraint if exists keyflow_daily_questions_content_type_check;

alter table public.keyflow_daily_questions
  add constraint keyflow_daily_questions_content_type_check
  check (content_type in ('question', 'answer'));

-- 更新写入 RPC：优先使用前端传入的 content_type；未传时按 URL 是否含 /answer/ 自动判断。
drop function if exists public.keyflow_admin_create_daily_questions(uuid, jsonb);
create or replace function public.keyflow_admin_create_daily_questions(
  p_token uuid,
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
  select trim(item->>'title'),
         split_part(trim(item->>'zhihu_url'), '?', 1),
         case
           when trim(item->>'content_type') in ('answer', 'question') then trim(item->>'content_type')
           when split_part(trim(item->>'zhihu_url'), '?', 1) ~ '/answer/\d+' then 'answer'
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

revoke all on function public.keyflow_admin_create_daily_questions(uuid, jsonb) from public;
grant execute on function public.keyflow_admin_create_daily_questions(uuid, jsonb) to anon;
