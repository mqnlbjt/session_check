# Issue #17: 安装治理（两阶段落地 + 一键撤销）

> Parent: 期6 改进清单（grill 安装治理分支：两阶段预览、spectator 执行写配置边界；撤销入口已确认要）

## What to build

- **两阶段落地**（复用沉淀两阶段模式 commit 6c154d6）：推荐卡片「预览」→ 展示目标文件 + 待写内容 → 用户确认 → spectator 才执行写操作（装 skill 到 user 级 / 写 hook 配置 / 写 AGENTS.md 标记块）
- **installations 表**：installed_at、推荐物标识 + pin 版本、目标文件、采纳前信号基线快照（供 #18 对比）、状态
- **已采纳历史区**：展示已装项（pin 版本、安装日期、效果状态）
- **一键撤销**：卸载 skill / 还原 hook 配置 / 移除 AGENTS.md 标记块；撤销后状态置 uninstalled，推荐可重新出现（与 dismissed 区分）
- 边界原则：所有写配置操作由 spectator 执行且可逆，不让用户手动去删

## Acceptance criteria

- [ ] 未确认前不落盘（预览纯只读）
- [ ] 安装后 installations 表有完整快照（含采纳前基线）
- [ ] 撤销可完全还原（文件内容级），撤销后推荐可再次生成
- [ ] 重复安装幂等
- [ ] 测试覆盖两阶段与撤销还原

## Blocked by

- #16 推荐物组装 + 改进清单 UI
