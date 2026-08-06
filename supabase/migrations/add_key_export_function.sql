-- 批量导出活动 Key 明文，供后台下载 Excel 使用。
drop function if exists public.keyflow_export_keys(uuid);

create or replace function public.keyflow_export_keys(p_activity_id uuid)
returns table(
  key_value text,
  platform text,
  application_id uuid,
  created_at timestamptz,
  claimed_at timestamptz,
  applicant_name text
)
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  select k.key_value, k.platform, k.application_id, k.created_at, k.claimed_at, a.zhihu_name
  from keyflow_keys k
  left join keyflow_applications a on a.id = k.application_id
  where k.activity_id = p_activity_id
  order by k.created_at desc;
end;
$$;

grant execute on function public.keyflow_export_keys(uuid) to authenticated;
