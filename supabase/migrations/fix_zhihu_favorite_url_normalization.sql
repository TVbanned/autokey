-- 修复「游戏问题集散中心」重复问题。
-- 根因：知乎关注问题 API 返回的 url 是 /api/v4/questions/{id}，而公开地址是 /question/{id}；
-- 收藏写入时只去掉了 query 参数，未统一地址形式，同一问题以两种 URL 各存一条，绕过了唯一约束。
-- 处理：新增 URL 规范化函数 -> 清洗现有重复 -> 写入 RPC 统一规范化 -> 答主看板关联统一规范化。

-- 1) URL 规范化函数（写入 RPC 与数据清洗共用）
create or replace function public.keyflow_normalize_zhihu_url(p_url text)
returns text
language sql immutable
as $$
  select nullif(
    regexp_replace(
      regexp_replace(
        regexp_replace(
          regexp_replace(
            rtrim(split_part(split_part(trim(coalesce(p_url, '')), '#', 1), '?', 1), '/'),
            '^https?://zhihu\.com/', 'https://www.zhihu.com/'
          ),
          '^https?://www\.zhihu\.com/api/v4/questions/([0-9]+)$',
          'https://www.zhihu.com/question/\1'
        ),
        '/api/v4/questions/([0-9]+)/?$',
        '/question/\1'
      ),
      '/answer(s)?/[0-9]+$', ''
    ),
    ''
  );
$$;

-- 2) 清洗现有数据：先放开唯一约束，统一地址后合并重复
alter table public.keyflow_zhihu_question_favorites
  drop constraint if exists keyflow_zhihu_question_favorites_zhihu_url_key;

update public.keyflow_zhihu_question_favorites
set zhihu_url = public.keyflow_normalize_zhihu_url(zhihu_url),
    updated_at = now()
where zhihu_url is distinct from public.keyflow_normalize_zhihu_url(zhihu_url);

-- 合并同一问题的重复收藏：title 取最长非空，source 优先保留 'daily'
with merged as (
  select zhihu_url,
         (array_agg(title order by length(title) desc nulls last))[1] as best_title,
         (array_agg(source order by (source = 'daily') desc, source nulls last))[1] as best_source
  from public.keyflow_zhihu_question_favorites
  group by zhihu_url
  having count(*) > 1
)
update public.keyflow_zhihu_question_favorites f
set title = m.best_title,
    source = m.best_source,
    updated_at = now()
from merged m
where f.zhihu_url = m.zhihu_url
  and (f.title is distinct from m.best_title or f.source is distinct from m.best_source);

delete from public.keyflow_zhihu_question_favorites f
using (
  select id,
         row_number() over (partition by zhihu_url order by created_at asc, id asc) as rn
  from public.keyflow_zhihu_question_favorites
) ranked
where f.id = ranked.id and ranked.rn > 1;

alter table public.keyflow_zhihu_question_favorites
  add constraint keyflow_zhihu_question_favorites_zhihu_url_key unique (zhihu_url);

-- 3) 写入 RPC 统一使用规范化函数
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
  v_url text := public.keyflow_normalize_zhihu_url(p_zhihu_url);
  result public.keyflow_zhihu_question_favorites;
begin
  if not public.keyflow_is_admin(p_token) then
    raise exception '管理员权限不足';
  end if;

  if v_url = '' then
    raise exception '无效的知乎链接';
  end if;

  if p_favorite then
    insert into public.keyflow_zhihu_question_favorites (zhihu_url, title, source)
    values (v_url, trim(coalesce(p_title, '')), coalesce(nullif(trim(p_source), ''), 'following'))
    on conflict (zhihu_url) do update
      set title = excluded.title,
          source = excluded.source,
          updated_at = now()
    returning * into result;
  else
    delete from public.keyflow_zhihu_question_favorites
    where zhihu_url = v_url
    returning * into result;
  end if;

  return result;
end;
$$;

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
    v_url := public.keyflow_normalize_zhihu_url(coalesce(v_item->>'zhihu_url', ''));
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

-- 4) 答主看板 RPC：关联投稿人时统一规范化，避免地址形式不一致导致漏关联
drop function if exists public.keyflow_answerer_zhihu_question_favorites(uuid);

create or replace function public.keyflow_answerer_zhihu_question_favorites(p_answerer_id uuid)
returns table (
  id uuid,
  zhihu_url text,
  title text,
  source text,
  created_at timestamptz,
  updated_at timestamptz,
  answerer_id uuid,
  answerer_name text
)
language sql stable security definer set search_path = public
as $$
  select f.id, f.zhihu_url, f.title, f.source, f.created_at, f.updated_at,
         dq.answerer_id,
         a.zhihu_name as answerer_name
  from public.keyflow_zhihu_question_favorites f
  left join lateral (
    select q.answerer_id
    from public.keyflow_daily_questions q
    where public.keyflow_normalize_zhihu_url(q.zhihu_url) = f.zhihu_url
      and q.answerer_id is not null
    order by q.created_at desc
    limit 1
  ) dq on true
  left join public.keyflow_answerers a on a.id = dq.answerer_id
  order by f.created_at desc
  limit 20;
$$;

revoke all on function public.keyflow_admin_toggle_zhihu_question_favorite(text, text, text, text, boolean) from public;
revoke all on function public.keyflow_admin_batch_favorite_zhihu_questions(text, jsonb, text, boolean) from public;
revoke all on function public.keyflow_answerer_zhihu_question_favorites(uuid) from public;
grant execute on function public.keyflow_admin_toggle_zhihu_question_favorite(text, text, text, text, boolean) to anon;
grant execute on function public.keyflow_admin_batch_favorite_zhihu_questions(text, jsonb, text, boolean) to anon;
grant execute on function public.keyflow_answerer_zhihu_question_favorites(uuid) to anon;
