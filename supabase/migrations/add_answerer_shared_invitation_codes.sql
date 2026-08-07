-- 答主分享邀请码：答主可在看板生成邀请码分享给他人注册

-- 1. 邀请码表增加 generated_by_answerer_id 列
alter table public.keyflow_invitation_codes
  add column if not exists generated_by_answerer_id uuid references public.keyflow_answerers(id) on delete set null;

create index if not exists keyflow_invitation_codes_generated_by_idx
  on public.keyflow_invitation_codes(generated_by_answerer_id);

-- 2. code_type 增加 'answerer_shared'
alter table public.keyflow_invitation_codes
  drop constraint if exists keyflow_invitation_codes_code_type_check;

alter table public.keyflow_invitation_codes
  add constraint keyflow_invitation_codes_code_type_check
  check (code_type in ('answerer', 'partner', 'answerer_shared'));

-- 3. RPC：答主生成分享邀请码（每天限 1 个）
create or replace function public.keyflow_generate_answerer_shared_code(
  p_answerer_id uuid
)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_code text;
  v_id uuid;
  v_today_count integer;
begin
  -- 检查今日是否已生成
  select count(*) into v_today_count
  from keyflow_invitation_codes
  where generated_by_answerer_id = p_answerer_id
    and code_type = 'answerer_shared'
    and created_at >= date_trunc('day', now());

  if v_today_count >= 1 then
    raise exception '今日已生成邀请码，每天限生成 1 个';
  end if;

  -- 生成邀请码（最多重试 10 次避免碰撞）
  for i in 1..10 loop
    v_code := 'AS-' || upper(substr(md5(gen_random_uuid()::text || clock_timestamp()::text), 1, 8));
    insert into keyflow_invitation_codes (code, code_type, generated_by_answerer_id)
    values (v_code, 'answerer_shared', p_answerer_id)
    on conflict (code) do nothing
    returning id into v_id;
    if v_id is not null then
      return json_build_object('id', v_id, 'code', v_code, 'created_at', now());
    end if;
  end loop;

  raise exception '邀请码生成失败，请重试';
end;
$$;

grant execute on function public.keyflow_generate_answerer_shared_code(uuid) to anon, authenticated;

-- 4. RPC：获取答主今日已生成的分享邀请码
create or replace function public.keyflow_get_answerer_shared_code(
  p_answerer_id uuid
)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_result json;
begin
  select row_to_json(c) into v_result
  from (
    select id, code, created_at
    from keyflow_invitation_codes
    where generated_by_answerer_id = p_answerer_id
      and code_type = 'answerer_shared'
      and created_at >= date_trunc('day', now())
    order by created_at desc
    limit 1
  ) c;

  return v_result;
end;
$$;

grant execute on function public.keyflow_get_answerer_shared_code(uuid) to anon, authenticated;

-- 5. RPC：获取答主分享邀请码列表（管理后台下载用）
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
