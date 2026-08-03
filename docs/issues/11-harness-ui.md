# Issue #11: Harness 页前端

> Parent: docs/prd-enhancement-2026.md 期 5

## What to build

顶栏第四个 tab「Harness」：

- 模型建议区：卡片列表（文案 + 数据依据）
- 防呆规则区：按项目分组
  - 项目无建议时：「生成建议」按钮（POST generate，轮询等新建议出现）
  - 建议卡片：规则文案 + 依据（信号统计）+「采纳」/「忽略」按钮
  - 已采纳显示写入路径，已忽略默认折叠
- 采纳后 Toast/状态反馈

## Acceptance criteria

- [ ] 模型建议渲染
- [ ] 生成按钮触发后轮询拿到新建议
- [ ] 采纳/忽略操作生效并即时反馈
- [ ] build:web 通过

## Blocked by

- #10 Harness 建议引擎 + API
