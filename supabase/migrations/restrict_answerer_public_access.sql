-- 紧急止血：答主资料（含微信号）不得由客户端直接批量读取。
drop policy if exists "keyflow public answerer access" on public.keyflow_answerers;

create policy "keyflow answerers no client access"
  on public.keyflow_answerers
  for all to anon, authenticated
  using (false)
  with check (false);

revoke all on table public.keyflow_answerers from anon, authenticated;
