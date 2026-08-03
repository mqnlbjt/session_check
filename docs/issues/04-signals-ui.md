# Issue #4: 信号前端展示

> Parent: docs/prd-enhancement-2026.md 期 2

## What to build

- 会话列表（SessionItem）：correction_count > 0 时显示琥珀色纠正标记（如 ⚠ 3）
- 会话页：信号 chips（类似现有风险 chips 区），点击定位到对应用户消息（复用期 1 的 data-seq 跳转/闪烁）
- 大盘（OverviewView）：返工率周趋势（有 ≥1 次纠正的会话占比，按周聚合，来自 /api/overview 扩展）

## Acceptance criteria

- [ ] 列表行能看到纠正次数标记
- [ ] 会话页信号 chip 点击跳到对应消息并高亮
- [ ] 大盘有返工率趋势卡片
- [ ] npm run build 通过

## Blocked by

- #3 返工信号检测 + 回填 + API
