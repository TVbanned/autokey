-- 修复 HD-2D 同一请求的生成扣减与退款幂等约束

drop index if exists public.hd2d_quota_ledger_generation_request_idx;
create unique index if not exists hd2d_quota_ledger_generation_request_idx
  on public.hd2d_quota_ledger(user_id, request_id, source)
  where request_id is not null and source in ('generation', 'generation_refund');
