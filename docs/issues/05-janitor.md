# Issue #5: janitor 数据清理

> Parent: docs/prd-enhancement-2026.md 期 3

## What to build

老会话工具输出清理：

- `src/janitor.ts`：找 `COALESCE(ended_at, started_at) < now-90d` 的会话，把其 messages 的 `blocks_json` 中 `tool_result` block 的 output 置空（保留 block 结构），统计释放字节
- **不清** `text`/`tool_call`：FTS 索引、信号、搜索全部不受影响
- `janitor_log` 表：`id, run_at, sessions, messages, bytes_freed`
- 触发：serve 启动时跑一次 + 每 24h 一次；`npm run janitor` 手动
- 清理后 `PRAGMA wal_checkpoint(TRUNCATE)`；释放 >50MB 才 VACUUM（VACUUM 重写全库，小收益不值得）
- 长跑会话保护：ended_at 最新的会话不按 started_at 误清（COALESCE 已保证，测试验证）

## Acceptance criteria

- [ ] 91 天前会话的 tool_result output 被清空，text/tool_call 保留
- [ ] 89 天前会话不动
- [ ] started_at 老但 ended_at 新的长跑会话不动
- [ ] 清理后该会话消息仍能被 FTS 搜到（text 未动）
- [ ] janitor_log 记录正确（sessions/messages/bytes_freed）
- [ ] 重复跑幂等（第二次 0 释放）

## Blocked by

- #0 测试基建（已合并）
