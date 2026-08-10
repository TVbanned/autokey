-- 为 avatars 存储桶添加 Storage RLS 策略
-- 允许任何人查看头像（公开读取）
create policy "avatars public read" on storage.objects
  for select using (bucket_id = 'avatars');

-- 允许任何人上传头像（公开写入）
create policy "avatars public insert" on storage.objects
  for insert with check (bucket_id = 'avatars');

-- 允许任何人更新头像（公开更新）
create policy "avatars public update" on storage.objects
  for update using (bucket_id = 'avatars') with check (bucket_id = 'avatars');
