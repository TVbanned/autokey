# Debug Session: activity-create-duplicate
- **Status**: [OPEN]
- **Issue**: 新创建测评活动时提示 `duplicate key value violates unique constraint "keyflow_activities_pkey"`
- **Debug Server**: http://127.0.0.1:7777/event
- **Log File**: `.dbg/trae-debug-log-activity-create-duplicate.ndjson`

## Reproduction Steps
1. 打开活动概览并点击新建活动。
2. 填写活动标题、游戏名称、Steam 地址、人数、报名和交付截止时间、简介及测试要求。
3. 点击“保存并创建”。
4. 页面提示数据库主键重复。

## Hypotheses & Verification
| ID | Hypothesis | Likelihood | Effort | Evidence |
|----|------------|------------|--------|----------|
| A | 创建请求生成了重复的活动主键 | High | Low | Pending |
| B | 前端重复提交导致同一请求发送两次 | Med | Low | Pending |
| C | 主键生成依赖的序列或时间值异常 | Med | Med | Pending |
| D | 已存在同一活动记录，但保存流程错误复用了固定 key | Med | Low | Pending |
| E | 失败重试时复用了旧 key | Low | Med | Pending |

## Log Evidence
Pending runtime evidence.

## Verification Conclusion
Pending pre-fix and post-fix comparison.
