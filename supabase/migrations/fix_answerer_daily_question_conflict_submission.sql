-- 修复答主投稿问题命中已存在记录时被静默吞掉的问题。
-- 场景：答主提交的问题在 keyflow_daily_questions 已存在（后台预置/自动生成），
-- 旧 RPC 的 ON CONFLICT 分支只 set updated_at = now()，
-- 导致答主看到「投稿成功」但后台没有任何可见的新记录（answerer_id 未记录、processed 未重置）。
-- 修复：冲突时记录投稿人 answerer_id，并重置为未处理，让投稿在后台可见。

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
    set answerer_id = p_answerer_id,
        processed = false,
        processed_at = null,
        updated_at = now()
  returning *;
end;
$$;

revoke all on function public.keyflow_answerer_create_daily_questions(uuid, jsonb) from public;
grant execute on function public.keyflow_answerer_create_daily_questions(uuid, jsonb) to anon;

-- 回补：灰域信风（723486d2-04e9-4065-888a-188c6f41251f）19:37 提交的
-- 《杀手》GTA6 NPC 问题（99a776db-58fc-4450-ae09-141435023263）被旧逻辑吞掉，
-- 现按修复后语义标记为其投稿并重置为未处理，使该投稿在后台可见。
update public.keyflow_daily_questions
set answerer_id = '723486d2-04e9-4065-888a-188c6f41251f',
    processed = false,
    processed_at = null,
    updated_at = now()
where id = '99a776db-58fc-4450-ae09-141435023263';
