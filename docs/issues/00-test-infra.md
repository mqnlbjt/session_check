# Issue #0: 测试基建（prefactor）

> Parent: docs/prd-enhancement-2026.md 期 1

## What to build

引入 vitest，让 Hono API 可以被 `app.request()` 直接测试：

- 安装 vitest 依赖，`npm test` 可运行
- `server.ts` 的 Hono app 创建逻辑抽成可注入 db 的工厂函数（`createApp(db)`），`main.ts serve` 用真实 db 调用
- better-sqlite3 支持 `:memory:` 临时库，schema 初始化函数可复用
- 写一个示例测试（如 `/api/sessions` 空库返回空列表）证明接缝可用

## Acceptance criteria

- [ ] `npm test` 跑通至少 1 个 API 层测试
- [ ] 测试用内存 db，不碰真实 spectator.db
- [ ] `npm run serve` 行为不变

## Blocked by

None - can start immediately
