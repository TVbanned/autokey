-- 回填所有已有 applications 的 answerer_id（通过 zhihu_name 匹配）
update public.keyflow_applications app
set answerer_id = a.id
from public.keyflow_answerers a
where app.answerer_id is null
  and app.zhihu_name = a.zhihu_name;

-- 触发器：INSERT 时自动填充 answerer_id
create or replace function public.keyflow_autofill_answerer_id()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.answerer_id is null and new.zhihu_name is not null then
    select a.id into new.answerer_id
    from public.keyflow_answerers a
    where a.zhihu_name = new.zhihu_name
    limit 1;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_autofill_answerer_id on public.keyflow_applications;
create trigger trg_autofill_answerer_id
  before insert or update on public.keyflow_applications
  for each row
  when (pg_trigger_depth() = 0)
  execute function public.keyflow_autofill_answerer_id();
