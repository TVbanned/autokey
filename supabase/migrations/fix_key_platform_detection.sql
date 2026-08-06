-- 根据正确格式重新识别存量 Key 的平台
update public.keyflow_keys
set platform = case
  when key_value ~ '^[A-Z0-9]{5}-[A-Z0-9]{5}-[A-Z0-9]{5}$' then 'steam'
  when key_value ~ '^[A-Z0-9]{4}(-[A-Z0-9]{4}){3}$' then 'ubi'
  when key_value ~ '^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$' or key_value ~ '^[A-Z0-9]{10}$' then 'ps5'
  when key_value ~ '^[A-Z0-9]{16}$' then 'switch'
  else platform
end
where platform = 'unknown';
