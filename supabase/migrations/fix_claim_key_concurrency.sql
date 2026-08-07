-- ponytail: lock the application row before checking or binding a Key to serialize concurrent claims
create or replace function public.keyflow_claim_key(p_application_id uuid)
returns table(key_value text, claimed_at timestamptz)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_activity_id uuid;
  v_key_id uuid;
begin
  select activity_id into v_activity_id
  from keyflow_applications
  where id = p_application_id and status = 'selected'
  for update;

  if v_activity_id is null then
    raise exception '该答主尚未入选或不存在';
  end if;

  return query
  select k.key_value, k.claimed_at
  from keyflow_keys k
  where k.application_id = p_application_id;
  if found then
    return;
  end if;

  select k.id into v_key_id from keyflow_keys k
  where k.activity_id = v_activity_id and k.application_id is null
  order by k.created_at
  for update skip locked
  limit 1;

  if v_key_id is null then
    raise exception '暂无可领取的 Key';
  end if;

  update keyflow_keys set application_id = p_application_id, claimed_at = now() where id = v_key_id;
  return query select k.key_value, k.claimed_at from keyflow_keys k where k.id = v_key_id;
end;
$$;

grant execute on function public.keyflow_claim_key(uuid) to anon, authenticated;
