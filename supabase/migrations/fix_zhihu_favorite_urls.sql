-- 将历史收藏中误保存的知乎 API 问题地址转换为公开页面地址，并合并重复记录。
with mapped as (
  select
    id,
    'https://www.zhihu.com/question/' || (regexp_match(zhihu_url, '/api/v4/questions/([0-9]+)/?$'))[1] as public_url
  from public.keyflow_zhihu_question_favorites
  where zhihu_url ~ '/api/v4/questions/[0-9]+/?$'
), duplicates as (
  select m.id
  from mapped m
  where exists (
    select 1
    from public.keyflow_zhihu_question_favorites f
    where f.zhihu_url = m.public_url
  )
)
delete from public.keyflow_zhihu_question_favorites f
where f.id in (select id from duplicates);

with mapped as (
  select
    id,
    'https://www.zhihu.com/question/' || (regexp_match(zhihu_url, '/api/v4/questions/([0-9]+)/?$'))[1] as public_url
  from public.keyflow_zhihu_question_favorites
  where zhihu_url ~ '/api/v4/questions/[0-9]+/?$'
)
update public.keyflow_zhihu_question_favorites f
set zhihu_url = mapped.public_url,
    updated_at = now()
from mapped
where f.id = mapped.id;
