# Issue #6: 会话导出 Markdown

> Parent: docs/prd-enhancement-2026.md 期 3

## What to build

- `GET /api/sessions/:id/export.md`：生成 Markdown 下载
  - frontmatter：title/agent/project/model/起止时间/消息数/token
  - 正文按时间流：`## [HH:MM:SS] 用户/助手/工具`，text 原样、tool_call 渲染为代码块（工具名+入参）、tool_result 折叠为输出块（过长截断 2000 字符）
  - Content-Disposition attachment，文件名含会话标题
- 前端：ConversationView 头部加「导出」按钮（<a> 直链下载）

## Acceptance criteria

- [ ] 导出的 md 含 frontmatter 元数据
- [ ] 消息按序渲染，tool_call/ tool_result 格式可读
- [ ] 不存在的会话 404
- [ ] 前端按钮触发下载
- [ ] npm run build 通过

## Blocked by

- 无（与 #5 独立，可并行）
