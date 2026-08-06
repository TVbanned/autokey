-- 邀请码是平台级答主注册凭证，不绑定具体游戏活动
alter table public.keyflow_invitation_codes
  alter column activity_id drop not null;

create unique index if not exists keyflow_invitation_codes_code_unique_idx
  on public.keyflow_invitation_codes (code);

-- 替换按活动生成的邀请码函数
create or replace function public.keyflow_generate_invitation_codes(
  p_count integer default 10
)
returns setof public.keyflow_invitation_codes
language plpgsql
security definer
set search_path = public
as $$
declare
  i integer;
  v_code text;
  v_id uuid;
  v_generated integer := 0;
begin
  for i in 1..p_count * 3 loop
    exit when v_generated >= p_count;
    v_code := 'KF-' || upper(substr(md5(gen_random_uuid()::text || clock_timestamp()::text), 1, 8));
    insert into keyflow_invitation_codes (code)
    values (v_code)
    on conflict (code) do nothing
    returning id into v_id;
    if v_id is not null then
      v_generated := v_generated + 1;
      return query select * from keyflow_invitation_codes where id = v_id;
    end if;
  end loop;
end;
$$;

grant execute on function public.keyflow_generate_invitation_codes(integer) to anon, authenticated;
