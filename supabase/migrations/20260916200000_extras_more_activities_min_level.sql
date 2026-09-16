-- 答主看板「更多体验活动」卡片需要展示等级门槛：给 keyflow_answerer_dashboard_extras 的
-- more_activities 补一个 min_level 字段。
-- 做法：读取线上函数定义 → 精确替换 more_activities 那一处 → 重建（幂等，可重复执行）。

do $$
declare
  v_def text;
  v_from text := E'        ''delivery_deadline'', a.delivery_deadline\n      ) order by a.created_at desc)';
  v_to text := E'        ''delivery_deadline'', a.delivery_deadline,\n        ''min_level'', coalesce(a.min_level, 0)\n      ) order by a.created_at desc)';
begin
  v_def := pg_get_functiondef('public.keyflow_answerer_dashboard_extras(uuid)'::regprocedure);

  if position(v_to in v_def) > 0 then
    return; -- 已经加过，跳过
  end if;

  if position(v_from in v_def) = 0 then
    raise exception '未找到 more_activities 锚点，函数定义可能已变化，请手工核对';
  end if;

  v_def := replace(v_def, v_from, v_to);
  execute v_def;
end $$;

select jsonb_build_object(
  'has_min_level', position('min_level' in pg_get_functiondef('public.keyflow_answerer_dashboard_extras(uuid)'::regprocedure)) > 0
) as applied;
