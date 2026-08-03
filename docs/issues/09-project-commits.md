# Issue #9: 项目成本 vs commit 并排曲线

> Parent: docs/prd-enhancement-2026.md 期 4

## What to build

项目下钻视图（分析页项目行点击展开）：

- `GET /api/analytics/project?path=`：返回该项目近 90 天 `{ daily: [{d, cost, output_tokens}], commits: [{d, n}] }`
  - commits：`git -C <path> log --since="90 days ago" --date=format:%Y-%m-%d --format=%ad`，execFile 数组参数（不走 shell），5s 超时，失败/非 git 仓库 → commits 为空数组（降级只显示成本）
  - **安全**：path 必须存在于 sessions.project_path（白名单），否则 404
  - **不做归属**：两条曲线并排展示，关联性由用户判断（grill 决策）
- 前端：项目行点击展开两条并排柱状图（成本 / commit 数）

## Acceptance criteria

- [ ] 非白名单 path 返回 404
- [ ] 真实 git 仓库返回 commit 计数
- [ ] 非 git 目录降级为空 commits 不报错
- [ ] 前端并排图渲染

## Blocked by

- #7 分析 API
