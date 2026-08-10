-- 修复答主分享邀请码的每日刷新时区问题
-- 之前 date_trunc('day', now()) 使用 UTC 时间, 导致北京时间新一天了邀请码还没刷新

-- 1. 修复生成函数
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
  -- 检查今日是否已生成（使用 Asia/Shanghai 时区）
  select count(*) into v_today_count
  from keyflow_invitation_codes
  where generated_by_answerer_id = p_answerer_id
    and code_type = 'answerer_shared'
    and (created_at at time zone 'Asia/Shanghai') >= date_trunc('day', (now() at time zone 'Asia/Shanghai'));

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

-- 2. 修复查询函数
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
      and (created_at at time zone 'Asia/Shanghai') >= date_trunc('day', (now() at time zone 'Asia/Shanghai'))
    order by created_at desc
    limit 1
  ) c;

  return v_result;
end;
$$;

grant execute on function public.keyflow_get_answerer_shared_code(uuid) to anon, authenticated;
