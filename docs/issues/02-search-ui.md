# Issue #2: 搜索 UI + 会话跳转定位

> Parent: docs/prd-enhancement-2026.md 期 1

## What to build

前端搜索闭环：

- 全局搜索页：顶部导航新入口，搜索框 + agent/项目过滤，结果列表展示高亮片段、会话标题、项目、时间
- 结果点击跳转 `?session=<id>&msg=<seq>`
- ConversationView 支持 `msg` query 参数：加载会话后滚动到对应消息并短暂高亮

## Acceptance criteria

- [ ] 搜索页能打出结果，关键词在片段中高亮
- [ ] 过滤条件生效
- [ ] 点击结果跳到会话页并定位到对应消息
- [ ] `npm run build` 通过

## Blocked by

- #1 FTS 索引 + 搜索 API
