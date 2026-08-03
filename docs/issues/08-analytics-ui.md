# Issue #8: 分析页前端

> Parent: docs/prd-enhancement-2026.md 期 4

## What to build

顶栏新 tab「分析」（独立页，不进大盘）：

- 热力图：7 行（星期）×24 列（小时）CSS grid，颜色深度表强度，hover 显示数值
- 模型对比表：模型 | 会话数 | 成本 | TPS | 平均纠正/会话
- 项目成本榜：路径 | 会话数 | 成本 | token，降序

## Acceptance criteria

- [ ] 三个区块渲染真实数据
- [ ] build:web 通过

## Blocked by

- #7 分析 API
