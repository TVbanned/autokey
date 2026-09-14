-- 热修复（2026-09-14，第二步）：每日投稿上限改为「LvX -> X 次」
--
-- 产品口径（现阶段）：答主每天可投的条数 = 当前等级数（LvX 对应 X 次）。
-- 分档规则（Lv1-2=1 / Lv3-5=2 / Lv6-8=3 / Lv9以上=4）留待后续大版本上线时再切换。
--
-- 说明：投稿触发器 keyflow_enforce_daily_submission_limit_v2 的额度只取自
--       keyflow_level_config.daily_post_limit（经 keyflow_daily_post_limit(level)），
--       所以改这一张配置表即可生效，无需改触发器、无需改前端。
--
-- 变更前的分档值已备份：codex-trae-sync/hotfix-20260914-daily-post-limit-backup.csv（100 行）
--
-- 大版本切回分档时，执行：
--   update public.keyflow_level_config
--      set daily_post_limit = case
--        when level <= 2 then 1
--        when level <= 5 then 2
--        when level <= 8 then 3
--        else 4
--      end;

update public.keyflow_level_config
   set daily_post_limit = level;
