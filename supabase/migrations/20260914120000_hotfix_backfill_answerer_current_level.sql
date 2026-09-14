-- 热修复（2026-09-14）：答主投稿上限被压在 Lv1 的「1 篇/天」  
--  
-- 现象：答主看板显示 LvX，但当天投第 2 条就被拒，报错为「今日投稿已达上限（Lv1 每天 1 篇）」。  
--  
-- 原因：gj 等级/金币系统上线时（20260908120000_gj_levels_coins_gates_shop_draft.sql）只给  
-- keyflow_answerers 增加了 current_level 列（not null default 1），没有按设计文档  
-- design-docs/gamejourney-v1-implementation-spec.md 第 85 行  
-- 「current_level：最近一次结算后的当前等级（初始=经验等级）」回填存量答主；  
-- 而 v2 投稿触发器按 keyflow_display_current_level() 读取 current_level 计算每日上限  
-- （keyflow_level_config.daily_post_limit：Lv1-2=1，Lv3-5=2，Lv6-8=3，Lv9以上=4），  
-- 于是全体答主额度都停在 Lv1 档 = 1 篇/天。  
--  
-- 处理：按经验等级回填 current_level / best_level，只执行一次（economy_config 打标记）。  
-- 不动触发器、不动前端；衰减/恢复逻辑保持原样。  
  
do $$  
declare  
  v_done boolean;  
begin  
  select exists (  
    select 1 from public.keyflow_economy_config  
    where key = 'current_level_backfill_20260914'  
  ) into v_done;  
  
  if v_done then  
    raise notice 'current_level backfill already applied, skip';  
    return;  
  end if;  
  
  update public.keyflow_answerers a  
     set current_level = greatest(1, public.keyflow_level_from_exp(public.keyflow_answerer_exp(a.id))),  
         best_level = greatest(a.best_level, public.keyflow_level_from_exp(public.keyflow_answerer_exp(a.id)));  
  
  insert into public.keyflow_economy_config (key, value, updated_at)  
  values ('current_level_backfill_20260914', 'true'::jsonb, now())  
  on conflict (key) do update  
    set value = excluded.value,  
        updated_at = now();  
end $$;  
  
-- 校验（执行后应返回 0 行）：  
-- select a.zhihu_name, a.current_level,  
--        public.keyflow_level_from_exp(public.keyflow_answerer_exp(a.id)) as exp_level  
--   from public.keyflow_answerers a  
--  where a.current_level != public.keyflow_level_from_exp(public.keyflow_answerer_exp(a.id));  
