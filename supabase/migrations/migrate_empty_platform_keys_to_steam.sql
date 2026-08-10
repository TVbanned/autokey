-- 补充处理历史空平台 Key：空值统一归为 Steam。
update public.keyflow_keys
set platform = 'steam'
where platform is null or trim(platform) = '' or platform = 'unknown';
