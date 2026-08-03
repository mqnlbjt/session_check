# Issue #10: Harness 建议引擎 + API

> Parent: docs/prd-enhancement-2026.md 期 5

## What to build

- `suggestions` 表：`id, project_path, kind('guard_rule'|'model_advice'), content, evidence, status('pending'|'adopted'|'dismissed'), created_at, adopted_to`
- 防呆规则生成（LLM）：`POST /api/harness/generate { project_path }` → 聚合该项目 top correction 信号（规则+频次+snippet 样本）→ headless agent（复用 review.ts runCli 逻辑）→ 返回 1-3 条规则文案（JSON 数组）→ 存 suggestions（pending）；后台异步，前端轮询
- 生成用的 agent：该项目会话数最多的 agent
- LLM 调用可注入（测试用假实现，不真 spawn）
- 模型建议（纯数据）：基于 modelCompare，成本 >$20 且存在「质量相当但成本低 >50%」的替代（平均纠正率容差 +0.2、替代会话数 ≥5）→ 生成建议文案，随 GET 返回，不落库（注：初版要求 avg_corrections ≥1，实测后发现「纠正率相当但贵 17 倍」同样值得建议，故放宽）
- `GET /api/harness/suggestions`：pending 优先 + modelAdvice
- `POST /api/harness/suggestions/:id/adopt`：复用 persistToInstructions 写入项目 AGENTS.md 标记块，状态→adopted 记 adopted_to
- `POST /api/harness/suggestions/:id/dismiss`：状态→dismissed

## Acceptance criteria

- [ ] 假 LLM 注入时 generate 产出规则落 suggestions
- [ ] LLM 返回非 JSON 时不落库不炸（解析容错）
- [ ] adopt 写入 AGENTS.md 标记块且幂等（upsertBlock 既有能力）
- [ ] dismiss 后不再出现在 pending 列表
- [ ] modelAdvice：高成本高纠正模型产生建议文案

## Blocked by

- #3 信号、#7 分析（已合并）
