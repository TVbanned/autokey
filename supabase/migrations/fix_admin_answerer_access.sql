-- 后台答主管理必须通过受管理员角色保护的 RPC，不能直接访问答主资料表。
create or replace function public.keyflow_admin_answerer_summaries()
returns table (
  id uuid,
  serial_number integer,
  zhihu_name text,
  account_address text,
  avatar_url text,
  remark text,
  created_at timestamptz,
  updated_at timestamptz
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.keyflow_is_admin() then
    raise exception '管理员权限不足';
  end if;

  return query
  select
    a.id,
    a.serial_number,
    a.zhihu_name,
    a.account_address,
    a.avatar_url,
    a.remark,
    a.created_at,
    a.updated_at
  from public.keyflow_answerers a
  order by a.created_at desc;
end;
$$;

create or replace function public.keyflow_admin_update_answerer_remark(
  p_answerer_id uuid,
  p_remark text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.keyflow_is_admin() then
    raise exception '管理员权限不足';
  end if;

  update public.keyflow_answerers
  set remark = coalesce(p_remark, ''), updated_at = now()
  where id = p_answerer_id;
end;
$$;

create or replace function public.keyflow_admin_delete_answerer(p_answerer_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.keyflow_is_admin() then
    raise exception '管理员权限不足';
  end if;

  delete from public.keyflow_answerers where id = p_answerer_id;
end;
$$;

revoke all on function public.keyflow_admin_answerer_summaries() from public;
revoke all on function public.keyflow_admin_update_answerer_remark(uuid, text) from public;
revoke all on function public.keyflow_admin_delete_answerer(uuid) from public;
grant execute on function public.keyflow_admin_answerer_summaries() to authenticated;
grant execute on