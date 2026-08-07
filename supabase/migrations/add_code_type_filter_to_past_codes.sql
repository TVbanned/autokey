-- 过往邀请码 RPC 支持按 code_type 筛选
drop function if exists public.keyflow_get_past_invitation_codes();
drop function if exists public.keyflow_get_past_invitation_codes(text);

create or replace function public.keyflow_get_past_invitation_codes(
  p_code_type text default null
)
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
  where (ic.answerer_id is not null or ic.application_id is not null)
    and (p_code_type is null or ic.code_type = p_code_type)
  order by ic.used_at desc;
end;
$$;

grant execute on function public.keyflow_get_past_invitation_codes(text) to anon, authenticated;
