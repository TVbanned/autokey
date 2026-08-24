-- 修复：INSERT 时腾讯文档行号游标存在并发竞争。
-- 同一批多行 INSERT（如 keyflow_admin_create_daily_questions 一次写多条）会触发多个异步 net.http_post，
-- 各自在 Edge Function 里读到同一个 sheet.row，写到同一行互相覆盖，最终只剩最后写入的一条。
-- 改为由数据库原子分配行号（SELECT ... FOR UPDATE + UPDATE），Edge Function 只按返回的行号写入。

create or replace function public.keyflow_alloc_tencent_row(p_table text)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row int;
begin
  select coalesce((sheets -> p_table ->> 'row')::int, 2) into v_row
  from public.keyflow_tencent_docs_sync
  where id = 1
  for update;

  update public.keyflow_tencent_docs_sync
  set sheets = jsonb_set(
        coalesce(sheets, '{}'::jsonb),
        array[p_table, 'row'],
        to_jsonb(v_row + 1),
        true
      ),
      updated_at = now()
  where id = 1;

  return v_row;
end;
$$;
