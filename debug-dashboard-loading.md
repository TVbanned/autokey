# Debug Session: dashboard-loading
- **Status**: [OPEN]
- **Issue**: 答主看板持续加载，且“正在参与”的活动同时出现在“历史活动”。
- **Debug Server**: http://127.0.0.1:7777/event
- **Log File**: .dbg/trae-debug-log-dashboard-loading.ndjson

## Reproduction Steps
1. 以答主身份打开“我的看板”。
2. 查看“正在参与”与“历史活动”。

## Hypotheses & Verification
| ID | Hypothesis | Likelihood | Effort | Evidence |
|----|------------|------------|--------|----------|
| A | 看板 RPC 返回错误或未返回 | High | Low | Rejected |
| B | 本地答主会话缺少有效 ID | Medium | Low | Rejected |
| C | RPC 返回值不符合页面预期，渲染时失败 | Medium | Low | Rejected |
| D | 初始化 effect 未完成或发生未捕获异常 | Medium | Low | Rejected |
| E | 历史活动 RPC 未排除正在参与的活动 | High | Low | Confirmed |

## Log Evidence
- `trae-debug-log-dashboard-loading.ndjson` 第 10 行：活动 `674aeff0-188a-4ad5-b3dd-8cffb781600c` 同时位于 ongoing（pending）与 historical（pending）。

## Verification Conclusion
已在数据库 RPC 返回历史列表前按活动 ID 排除所有正在参与的活动，等待刷新验证。
