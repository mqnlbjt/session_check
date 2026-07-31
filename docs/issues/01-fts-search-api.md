# Issue #1: FTS 索引 + 搜索 API

> Parent: docs/prd-enhancement-2026.md 期 1

## What to build

端到端的搜索能力（不含前端）：

- 新增 FTS5 虚表 `messages_fts(message_id UNINDEXED, session_id UNINDEXED, content)`，`tokenize='trigram'`（中文可子串匹配；回填后实测体积，超 150MB 再评估）
- 索引范围：只索引 `text` block（user/assistant）+ `tool_call` 的 input 文本；`thinking`/`tool_result` 不索引
- `persist.ts` 写 messages 的同事务内同步写 FTS
- 回填脚本 `npm run backfill-fts`：遍历老消息重建索引，幂等（先 DELETE 再插 或 rebuild）
- API：`GET /api/search?q=&agent=&project=&limit=&offset=`，返回 `snippet(messages_fts, ...)` 高亮片段 + 消息所属会话信息（session id/title/project/agent/ts/seq）

## Acceptance criteria

- [ ] 构造含中文关键词的 fixture 消息，ingest 后 API 能搜到
- [ ] 英文关键词可搜到 text 和 tool_call input
- [ ] tool_result 的 output 内容搜不到（验证索引范围）
- [ ] agent/project 过滤生效
- [ ] 回填脚本对真实库跑完，`messages_fts` 行数与预期一致；重复跑幂等
- [ ] 真实库回填后实测 FTS 体积并记录（决策点：超 150MB 上报）

## Blocked by

- #0 测试基建
