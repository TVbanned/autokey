-- 前端实时检测知乎用户名是否已占用，重名则返回建议替代名
create or replace function public.keyflow_check_zhihu_name(p_name text)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_suggested_name text;
  v_suffix int := 1;
begin
  if not exists (select 1 from keyflow_answerers where zhihu_name = p_name) then
    return json_build_object('exists', false);
  end if;

  loop
    v_suggested_name := p_name || lpad(v_suffix::text, 2, '0');
    if not exists (select 1 from keyflow_answerers where zhihu_name = v_suggested_name) then
      exit;
    end if;
    v_suffix := v_suffix + 1;
  end loop;
  return json_build_object('exists', true, 'suggestion', v_suggested_name);
end;
$$;

grant execute on function public.keyflow_check_zhihu_name(text) to anon, authenticated;
