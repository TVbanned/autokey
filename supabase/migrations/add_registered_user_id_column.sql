-- 更新 keyflow_get_answerer_shared_codes RPC，新增 registered_user_id 返回列
drop function if exists public.keyflow_get_answerer_shared_codes();

create or replace function public.keyflow_get_answerer_shared_codes()
returns table (
  answerer_name text,
  code text,
  is_used boolean,
  new_registered_user text,
  registered_user_id text
)
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  select
    gen_a.zhihu_name as answerer_name,
    ic.code,
    (ic.answerer_id is not null or ic.application_id is not null) as is_used,
    coalesce(reg_a.zhihu_name, app.zhihu_name, '') as new_registered_user,
    case when reg_a.serial_number is not null then lpad(reg_a.serial_number::text, 3, '0') else '' end as registered_user_id
  from keyflow_invitation_codes ic
  join keyflow_answerers gen_a on ic.generated_by_answerer_id = gen_a.id
  left join keyflow_answerers reg_a on ic.answerer_id = reg_a.id
  left join keyflow_applications app on ic.application_id = app.id
  where ic.code_type = 'answerer_shared'
  order by ic.created_at desc;
end;
$$;

grant execute on function public.keyflow_get_answerer_shared_codes() to anon, authenticated;
