-- 上一条迁移把 keyflow_activity_question_rewards 的外键改成了 ON DELETE SET NULL，
-- 但 activity_question_id 本身是 NOT NULL，于是「同步题库」的 delete 会直接失败
-- （edge function 里没检查 delete 的返回值，表现为下一次 insert 报 question_id 唯一键冲突）。
-- 这里去掉 NOT NULL，让「奖励行跟着题目删除而置空、但保留去重键」这件事真正成立。

begin;

alter table public.keyflow_activity_question_rewards
  alter column activity_question_id drop not null;

commit;
