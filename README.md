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

# 前端
cd web && npm run dev    # 开发（:8322，代理 /api）
npm run build:web        # 构建到 web/dist，由后端托管
```

## 常驻部署（systemd user）

```bash
systemctl --user enable --now spectator   # 服务文件在 ~/.config/systemd/user/spectator.service
loginctl enable-linger $USER              # 未登录也运行（已配置）
journalctl --user -u spectator -f         # 看日志
```

## API

- `GET /api/sessions?agent=&q=&limit=&offset=&parent=&all=` — session 列表（默认只列主会话，带 spark 心电条数据）
- `GET /api/sessions/:id/messages?limit=&offset=` — 对话消息流（含消息级 TPS 估算、会话 avg_tps）
- `GET /api/stats` — 按 agent 汇总
- `GET /api/events` — SSE 实时事件（入库即推送）
- `POST /api/scan` — 手动触发全量扫描

## TPS 口径

- **claude**：assistant 分块按组计算（组总 output ÷ 组时长），间隔含工具执行时间，是下界估值
- **codex**：`token_count` 采样点差分，去掉 >2 分钟的非生成间隔，较准
- **pi**：session 文件不落 usage，无法统计

## Roadmap

- [x] 三家 parser + 统一入库
- [x] watch 增量同步
- [x] 基础 API
- [x] Vue SPA 仪表盘（对话列表 / 查看器 / subagent 树）
- [x] systemd 常驻 + SSE 实时推送
- [x] TPS 统计（claude 消息级 / codex 采样差分）
- [ ] 手动选中 → LLM 复盘（返工点、被纠正次数、可复用经验）
- [ ] 监控大盘（趋势 / 活跃项目 / 模型速度对比）
- [ ] pi token 补齐（需从 CLIProxyAPI 侧取数）
- [ ] 安全规则扫描
