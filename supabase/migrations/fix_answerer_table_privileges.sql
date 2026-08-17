-- 恢复 keyflow_answerers 表的表级权限（前端仍直接读写该表）
grant select, insert, update, delete on table public.keyflow_answerers to anon, authenticated;

-- 确保公开读写策略存在（幂等）
drop policy if exists "keyflow public answerer access" on public.keyflow_answerers;
create policy "keyflow public answerer access"
  on public.keyflow_answerers for all to anon, authenticated
  using (true) with check (true);
