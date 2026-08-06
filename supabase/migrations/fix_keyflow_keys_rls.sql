-- 添加 keyflow_keys 的 SELECT 策略，允许前端查询库存统计元数据
-- 前端查询只选择 id/activity_id/platform/application_id/created_at，不包含 key_value 明文
create policy "keyflow keys metadata select" on public.keyflow_keys
  for select to anon, authenticated
  using (true);
