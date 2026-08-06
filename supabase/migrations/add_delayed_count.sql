-- 为答主报名添加延迟提交次数字段
alter table public.keyflow_applications add column if not exists delayed_count integer not null default 0;

-- 查询答主历史延迟提交次数：统计该答主在所有活动中提交交付晚于交付截止时间的次数
create or replace function public.keyflow_get_author_delayed_count(p_zhihu_id text)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
begin
  select count(*)::integer into v_count
  from keyflow_deliveries d
  join keyflow_applications a on d.application_id = a.id
  join keyflow_activities act on a.activity_id = act.id
  where a.zhihu_id = p_zhihu_id
    and act.delivery_deadline is not null
    and d.submitted_at > act.delivery_deadline;
  return coalesce(v_count, 0);
end;
$$;

grant execute on function public.keyflow_get_author_delayed_count(text) to anon, authenticated;
