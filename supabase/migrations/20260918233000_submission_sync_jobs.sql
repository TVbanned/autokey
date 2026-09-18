-- 「投稿数据」页的一键同步：任务表 + 管理员接口（2026-09-18）
--
-- 背景：知乎侧数据（字数/曝光/阅读/点赞/评论）只能从公司数据平台的 sql-gateway 取，
--   而那个网关是内网（sql-gateway-mcp.tsn02.in.zhihu.com → 10.19.140.x），
--   公网上的 Supabase / ECS 都连不上。所以做成「页面下单 + 本机执行器干活」：
--     1) 后台点「立即同步」→ 写一条 pending 任务（本文件的两个 RPC）
--     2) 本机执行器（codex-trae-sync/sync-job-runner.ps1，Windows 计划任务每分钟跑一次）
--        领任务 → 跑 sync-submission-metrics.ps1 → 把结果写回这条任务
--     3) 页面轮询任务状态，显示「同步中 / 完成 N 条 / 失败原因」
--
-- 表只给 service_role 用（RLS 打开、不建 policy），前端一律走下面两个 SECURITY DEFINER 的 RPC。
--
-- 回滚：drop function public.keyflow_admin_submission_sync_status(text);
--       drop function public.keyflow_admin_request_submission_sync(text, integer);
--       drop table public.keyflow_sync_jobs;

begin;

create table if not exists public.keyflow_sync_jobs (
  id uuid primary key default gen_random_uuid(),
  kind text not null default 'submission_metrics',
  days integer not null default 30,
  status text not null default 'pending',        -- pending | running | success | failed
  requested_by text,                             -- 管理员显示名，或 'auto'
  requested_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  rows_written integer,
  window_end date,
  message text
);

create index if not exists keyflow_sync_jobs_status_idx
  on public.keyflow_sync_jobs (kind, status, requested_at desc);

alter table public.keyflow_sync_jobs enable row level security;

-- ---------- 下单：请求一次同步 ----------
create or replace function public.keyflow_admin_request_submission_sync(p_token text, p_days integer DEFAULT 30)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_admin_id uuid;
  v_admin_name text;
  v_job public.keyflow_sync_jobs;
begin
  v_admin_id := resolve_admin_token(p_token);
  if v_admin_id is null then
    raise exception '管理员权限不足';
  end if;

  -- 已经有排队中/同步中的任务就不再重复排（页面连点也只会有一条）
  select * into v_job
    from public.keyflow_sync_jobs
   where kind = 'submission_metrics'
     and status in ('pending', 'running')
   order by requested_at desc
   limit 1;
  if v_job.id is not null then
    return json_build_object('queued', false, 'job', row_to_json(v_job));
  end if;

  select coalesce(display_name, username) into v_admin_name
    from public.keyflow_admin_users where id = v_admin_id;

  insert into public.keyflow_sync_jobs (kind, days, status, requested_by)
  values ('submission_metrics', greatest(1, least(coalesce(p_days, 30), 365)), 'pending', coalesce(v_admin_name, '管理员'))
  returning * into v_job;

  return json_build_object('queued', true, 'job', row_to_json(v_job));
end;
$function$;

-- ---------- 查询：最新任务 + 当前数据新鲜度 ----------
create or replace function public.keyflow_admin_submission_sync_status(p_token text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_admin_id uuid;
  v_job json;
  v_meta json;
begin
  v_admin_id := resolve_admin_token(p_token);
  if v_admin_id is null then
    raise exception '管理员权限不足';
  end if;

  select row_to_json(j) into v_job
    from (
      select id, kind, days, status, requested_by, requested_at, started_at, finished_at,
             rows_written, window_end, message
        from public.keyflow_sync_jobs
       where kind = 'submission_metrics'
       order by requested_at desc
       limit 1
    ) j;

  select json_build_object(
    'rows', count(*),
    'last_synced_at', max(synced_at),
    'max_window_end', max(window_end)
  ) into v_meta
    from public.keyflow_submission_metrics;

  return json_build_object('job', v_job, 'metrics', v_meta);
end;
$function$;

grant execute on function public.keyflow_admin_request_submission_sync(text, integer) to anon, authenticated;
grant execute on function public.keyflow_admin_submission_sync_status(text) to anon, authenticated;

commit;
