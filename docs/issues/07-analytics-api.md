# Issue #7: 分析 API

> Parent: docs/prd-enhancement-2026.md 期 4

## What to build

三个聚合端点（主会话口径，近 90 天）：

- `GET /api/analytics/heatmap`：7×24（星期×小时）消息数 + output token 分布
- `GET /api/analytics/models`：按模型聚合 会话数/输入输出 token/成本（cache 折价）/avg_tps/平均每会话纠正数
- `GET /api/analytics/projects`：按 project_path 聚合 会话数/消息数/token/成本，按成本降序

## Acceptance criteria

- [ ] fixture 数据断言各聚合数值正确
- [ ] 只统计主会话（subagent 不进）
- [ ] 模型对比含平均每会话纠正数（依赖 signals 表）
- [ ] 测试全绿

## Blocked by

- #0 测试基建、#3 信号（已合并）
