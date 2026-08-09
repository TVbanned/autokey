# Debug Session: daily-submit-freeze
- **Status**: [OPEN]
- **Issue**: 答主看板提交日常投稿后，Trae 仍会卡死。
- **Debug Server**: http://127.0.0.1:7777/event
- **Log File**: .dbg/trae-debug-log-daily-submit-freeze.ndjson

## Reproduction Steps
1. 登录答主看板。
2. 填写日常投稿链接和标题并提交。
3. 观察 Trae 是否卡死，以及卡死发生在提交前、写入后或看板刷新后。

## Hypotheses & Verification
| ID | Hypothesis | Likelihood | Effort | Evidence |
|----|------------|------------|--------|----------|
| A | 提交处理在活动列表查询或标题扫描阶段阻塞 | Medium | Low | Rejected |
| B | 当日投稿计数或插入请求未返回 | Medium | Low | Partially confirmed |
| C | 投稿成功后的看板 RPC 未返回或返回数据量异常 | High | Low | Rejected |
| D | 看板状态更新后发生高成本渲染 | Medium | Low | Rejected |
| E | Trae 本地调试埋点请求本身形成额外负载 | Medium | Low | Pending |

## Log Evidence
- 活动列表查询在 447–641ms 返回，共 16 条，未见阻塞。
- 一次提交在活动查询后没有到达当日计数日志，说明流程在确认弹窗或提交过程中被打断。
- 另一次提交的当日计数在 332ms 返回，结果为 1；按每日限制被正常拦截。
- 看板 RPC 返回 1 条作品、1 个进行中活动、13 个历史活动，耗时 897–1961ms；浏览器无卡死，未支持渲染卡死假设。
- React StrictMode 使首次加载的看板 RPC 成对出现；投稿成功后不应再触发全量看板刷新。

## Verification Conclusion
移除投稿成功后的 `loadDashboard()`，仅在本地递增日常投稿计数；成功后显示明确的确认弹窗。待用户进行修复后验证。
