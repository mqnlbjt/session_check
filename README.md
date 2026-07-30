# spectator

Coding agent 会话观测站：纯观测地采集 pi / Claude Code / Codex 的本地会话，统一入库，Web 仪表盘实时监控，**让 agent 自己复盘自己的会话**，并把教训沉淀回 agent 的记忆（CLAUDE.md / AGENTS.md / skills）。

纯观测原则：不改任何 agent 配置、不拦截流量、只读 agent 自己落盘的 session 文件。

## 功能

**监控**
- 三家 agent 会话统一采集（append-only JSONL + offset 增量，chokidar watch 秒级入库）
- 监控大盘：今日活跃、30 天趋势（活跃会话/token/成本）、模型排行（含 TPS）、活跃项目
- 活跃会话实时条（5 分钟内有消息的会话）
- TPS 统计：claude 消息级分组估算、codex token_count 采样差分
- 成本统计：模型价格表（可配置）+ cache 折价（读 0.1x / 写 1.25x）
- 工具错误率监控、危险命令/明文密钥规则扫描（风险会话打标）
- subagent 会话自动识别并挂成树（claude `subagents/`、pi 嵌套目录/worker 标记）
- SSE 实时推送，页面自动刷新

**复盘**
- 「复盘」按钮：把压缩后的对话交给**会话自己的 agent** headless 评审（pi --print / claude -p / codex exec），统一 rubric：返工 / 用户纠正 / 理解偏差 / 亮点 / 可复用经验 / 风险
- 复盘沉淀（可选）：教训写入项目 `CLAUDE.md` / `AGENTS.md` 标记块，或蒸馏为按项目累积的 lessons skill
- agent 插件：`plugins/install.sh` 一键安装，会话里说「复盘这个会话」即可触发 agent 结合现场（repo 状态、git 历史）自查并回传

## 快速开始

```bash
git clone <repo> && cd spectator
npm install
cd web && npm install && npm run build && cd ..

npm run serve   # 启动 :8321（首次全量扫描约 1 分钟，之后 watch 增量）
```

打开 http://localhost:8321

### 常驻（systemd user）

```bash
# 参考 ~/.config/systemd/user/spectator.service 或自行创建：
# ExecStart=<repo>/node_modules/.bin/tsx src/main.ts serve
systemctl --user enable --now spectator
loginctl enable-linger $USER   # 未登录也运行
```

### agent 复盘插件（可选）

把「复盘这个会话」指令一键装到已有的 pi / claude / codex 里（拷贝 SKILL.md 到对应技能目录，幂等）。

```bash
bash plugins/install.sh              # 自动检测已装的 agent 并安装插件
bash plugins/install.sh uninstall    # 卸载
```

装完后在任意会话里说**「复盘这个会话」**，agent 会调 spectator API 找到自己的记录、结合现场（repo 状态 / git 历史）分析，回传复盘结果。

## 架构

```
~/.pi/agent/sessions ──┐
~/.claude/projects ────┼─▶ parsers（内容嗅探 agent 类型）─▶ SQLite ─▶ Hono API ─▶ Vue SPA
~/.codex/sessions ─────┘   (chokidar watch 增量)
                                    ▲
                                    │ POST /api/reviews
              agent headless 复盘（pi --print / claude -p / codex exec）
```

- 统一消息模型：user / assistant / tool / thinking / tool_call / tool_result
- 可靠性：offset 持久化，服务重启零丢失；消息级去重（event_id + 内容哈希）；codex resume 重放前缀跳过
- 监控目录配置化：`spectator.config.json` 或 `~/.config/spectator/config.json`

```json
{
  "sources": [{ "path": "~/other/agent/sessions", "agent": "pi" }],
  "prices": { "gpt-5.4": { "in": 2.5, "out": 15 } }
}
```

## API

- `GET /api/sessions?agent=&q=&parent=&limit=&offset=` — 会话列表（含心电条数据）
- `GET /api/sessions/:id/messages` — 对话消息流（含 TPS 估算）
- `GET /api/sessions/:id/reviews` / `POST /api/reviews` — 复盘记录
- `POST /api/sessions/:id/review` — 触发 agent 复盘（body: `{"persist": "none|instructions|skill"}`）
- `GET /api/overview` — 大盘聚合
- `GET /api/events` — SSE 实时事件
- `POST /api/scan` — 手动全量扫描

## 技术栈

TypeScript · Hono · better-sqlite3 · chokidar · Vue 3 · Vite
