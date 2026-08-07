-- 修复 keyflow_generate_invitation_codes 的 search_path，md5/gen_random_uuid 需要 pgcrypto (extensions schema)
create or replace function public.keyflow_generate_invitation_codes(
  p_count integer default 10,
  p_code_type text default 'answerer'
)
returns setof public.keyflow_invitation_codes
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  i integer;
  v_code text;
  v_id uuid;
  v_generated integer := 0;
begin
  if p_count < 1 or p_count > 100 then
    raise exception '邀请码数量必须在 1 到 100 之间';
  end if;
  if p_code_type not in ('answerer', 'partner') then
    raise exception '邀请码类型无效';
  end if;

  for i in 1..p_count * 3 loop
    exit when v_generated >= p_count;
    v_code := case when p_code_type = 'partner' then 'PT-' else 'KF-' end
      || upper(substr(md5(gen_random_uuid()::text || clock_timestamp()::text), 1, 8));
    insert into keyflow_invitation_codes (code, code_type)
    values (v_code, p_code_type)
    on conflict (code) do nothing
    returning id into v_id;
    if v_id is not null then
      v_generated := v_generated + 1;
      return query select * from keyflow_invitation_codes where id = v_id;
    end if;
  end loop;
end;
$$;

grant execute on function public.keyflow_generate_invitation_codes(integer, text) to anon, authenticated;
