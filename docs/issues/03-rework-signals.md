# Issue #3: 返工信号检测 + 回填 + API

> Parent: docs/prd-enhancement-2026.md 期 2

## What to build

纯规则的用户纠正/返工信号检测（不调 LLM）：

- 新增 `signals` 表：`id, session_id, message_id, rule, kind('correction'|'frustration'), snippet, ts`，`UNIQUE(session_id, message_id, rule)`
- 新增 `signal-rules.ts`（仿 rules.ts 结构，词表可独立调）：
  - 纠正类 correction：`不对|错了|重来|重新(来|做|写|弄|搞)|我不是说|我的意思是|你理解错|别改|撤销|回退`（`重新` 收窄为带宾语形式，减少误报）
  - 机器生成的 user 消息（subagent 任务书/会话续接摘要）整条约过，不计信号
  - 挫折类 frustration：`怎么又|还是不行|又挂了|算了`（不计入返工分）
  - 只扫 `role=user` 的 text block
- ingest 同事务检测写入（appendMessage 现有事务内）
- 回填 `npm run backfill-signals`：全量重建（DELETE + 重扫所有 user 消息，7580 条秒级），幂等
- `/api/sessions` 列表行带 `correction_count`（correction 类计数）
- `GET /api/sessions/:id/signals` 返回该会话信号明细（前端定位用）
- 回填后人工抽查 Top 命中评估误报，误报多则收紧词表再进前端

## Acceptance criteria

- [ ] user 文本含"不对/重来"等 → signals 落库 correction 类
- [ ] "怎么又/算了" → frustration 类，不计入 correction_count
- [ ] assistant/tool 消息含同样词不触发
- [ ] 回填两次结果一致（幂等）
- [ ] /api/sessions 返回 correction_count
- [ ] /api/sessions/:id/signals 返回明细
- [ ] 真实库回填后抽查 20 条命中，记录误报率

## Blocked by

- #0 测试基建（已合并 main）
