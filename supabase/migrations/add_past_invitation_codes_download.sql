-- RPC: 获取过往已使用的邀请码（用于下载）
create or replace function public.keyflow_get_past_invitation_codes()
returns table (
  code text,
  used_at timestamptz,
  claimer_name text,
  claimer_type text
)
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  select 
    ic.code,
    ic.used_at,
    coalesce(a.zhihu_name, app.zhihu_name) as claimer_name,
    case 
      when ic.answerer_id is not null then '答主注册'
      when ic.application_id is not null then '活动报名'
      else '未知'
    end as claimer_type
  from keyflow_invitation_codes ic
  left join keyflow_answerers a on ic.answerer_id = a.id
  left join keyflow_applications app on ic.application_id = app.id
  where ic.answerer_id is not null or ic.application_id is not null
  order by ic.used_at desc;
end;
$$;

grant execute on function public.keyflow_get_past_invitation_codes() to anon, authenticated;
