# spectator

纯观测的 coding agent 对话 review 工具。扫描 pi / Claude Code / Codex 的本地 session 文件，统一入库，Web 仪表盘浏览，手动选中对话触发 LLM 质量复盘。

## 架构

```
~/.pi/agent/sessions ──┐
~/.claude/projects ────┼─▶ parsers ─▶ SQLite ─▶ Hono API ─▶ Vue SPA (TODO)
~/.codex/sessions ─────┘   (chokidar watch 增量)
```

- 纯观测：不改任何 agent 配置，不拦截流量，只读 session 文件
- append-only JSONL + offset 增量：首次全量后，watch 只读增量字节
- 统一消息模型：user / assistant / tool / thinking / tool_call / tool_result

## 使用

```bash
npm run scan    # 全量扫描一次
npm run serve   # 启动常驻服务（:8321），先全量扫再 watch
npm run dev     # 开发模式（tsx watch）
```

## API

- `GET /api/sessions?agent=&q=&limit=&offset=` — session 列表
- `GET /api/sessions/:id/messages?limit=&offset=` — 对话消息流（id 需 URL encode）
- `GET /api/stats` — 按 agent 汇总
- `POST /api/scan` — 手动触发全量扫描

## Roadmap

- [x] 三家 parser + 统一入库
- [x] watch 增量同步
- [x] 基础 API
- [ ] Vue SPA 仪表盘（对话列表 / 查看器）
- [ ] 手动选中 → LLM 复盘（返工点、被纠正次数、可复用经验）
- [ ] token/成本统计页（pi session 无 usage 数据，需另寻来源）
- [ ] 安全规则扫描
