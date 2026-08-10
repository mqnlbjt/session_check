# spectator

Coding agent 会话观测站：纯观测地采集 pi / Claude Code / Codex 的本地会话，统一入库，Web 仪表盘实时监控，**让 agent 自己复盘自己的会话**，并把教训沉淀回 agent 的记忆（CLAUDE.md / AGENTS.md / skills）。

更进一步：观测到的行为模式 → 诊断 harness 缺口 → 菜单式推荐（skills / hooks / MCP）→ 两阶段确认落地 → 采纳后效果追踪，形成 **harness 改进闭环**。

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

**搜索与信号**
- 全文搜索：FTS5 trigram 索引消息正文 + 工具入参（中文可子串匹配），搜索结果点击定位到会话内消息
- 返工信号检测：纯规则识别用户纠正/挫折语句（不对/重来/别改/算了…），会话质量分、大盘返工率趋势
- 信号确认层：每条信号自动判定三档置信度——confirmed（前条 assistant 有写类工具动作）/ unconfirmed（有佐证无动作）/ likely-noise（噪声），ingest 与回填共用同一确定性分类器
- 误报治理：第一人称认错（"我搞错了"）与机器生成消息（subagent 任务书等）自动过滤

**复盘**
- 「复盘」按钮：把压缩后的对话交给**会话自己的 agent** headless 评审（pi --print / claude -p / codex exec），统一 rubric：返工 / 用户纠正 / 理解偏差 / 亮点 / 可复用经验 / 风险
- 复盘沉淀（两阶段）：生成待确认写入预览，确认后教训写入项目 `CLAUDE.md` / `AGENTS.md` 标记块，或蒸馏为按项目累积的 lessons skill
- agent 插件：`plugins/install.sh` 一键安装，会话里说「复盘这个会话」即可触发 agent 结合现场（repo 状态、git 历史）自查并回传

**数据治理**
- 90 天前会话自动清空工具输出（保留人话 + 元数据 + 搜索索引），定期 VACUUM，清理日志可查
- 单会话导出 Markdown

**分析**
- 使用热力图（时 × 星期）、模型对比（成本/TPS/失败率/延迟/缓存/纠正率/产出）、项目成本榜（成本 vs commit 并排曲线）
- 模型建议：30 天窗口，「质量相当但便宜得多」的替代自动浮现（结构化证据对比表）
- 任务 × 模型推荐：同任务类型下推荐质量相当的最便宜模型

**Harness 改进闭环**
- 防呆规则：项目高频纠正信号 → LLM 生成具体规则（90 天滚动窗、去重闭环、证据含前条 assistant 动作摘要）→ 采纳写入 AGENTS.md 标记块
- 根因分类：封闭枚举 6+1 类（需求理解偏差/越权改动/测试验证缺失/工具能力缺口/风格约定不符/环境上下文缺失+其他），LLM 只做选择题
- 静态确认：每类绑定确定性检查项（测试框架声明/hook 配置/受保护路径/测试命令占比…），1 次纠正 + 防护缺失确认即可推荐
- 改进清单：根因 + 可展开证据链（信号原文/检查结果/搜索词/安装量）+ skills/hooks/MCP 三家推荐物路由
- 安装治理：两阶段落地（预览含目标路径与内容，确认才执行），installations 全量快照（版本/基线/备份），一键撤销完全可逆
- 验证闭环：采纳前后同类信号频率按周归一化对比，30 天出三态（生效中/未生效/已卸载），固定归因声明「信号下降 ≠ 推荐生效」——只展示不判决

## 快速开始

```bash
git clone https://github.com/mqnlbjt/session_check.git spectator && cd spectator
npm install
cd web && npm install && npm run build && cd ..

npm run serve   # 启动 :8321（首次全量扫描约 1 分钟，之后 watch 增量）
```

打开 http://localhost:8321

### 从旧版更新

历史经过重写（脱敏），直接 `git pull` 会报 unrelated histories：

```bash
git fetch origin && git reset --hard origin/main
# 或干脆重克隆（spectator.db 是本地数据，不在 git 里，拷过来即可）

npm install          # 新依赖
npm run build:web    # 重建前端
npm run backfill-signals  # 老库补信号新字段（confirmation 等，LLM 分类成果会自动保留）
```

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

## 安全默认

- 只绑回环地址 `127.0.0.1`（会话全文是敏感数据）。确需远程访问：`SPECTATOR_HOST=0.0.0.0 npm run serve` 显式放行
- 所有写配置操作两阶段确认 + 可逆（installations 备份还原）
- skill 安装名白名单校验（防 flag 注入/路径穿越）

## API

- `GET /api/sessions?agent=&q=&parent=&limit=&offset=` — 会话列表（含心电条数据）
- `GET /api/sessions/:id/messages` — 对话消息流（含 TPS 估算）
- `GET /api/sessions/:id/signals?confirmation=` — 会话信号明细（可按置信度过滤）
- `GET /api/search?q=&agent=&project=` — 全文搜索
- `GET /api/sessions/:id/reviews` / `POST /api/reviews` — 复盘记录
- `POST /api/sessions/:id/review` — 触发 agent 复盘（body: `{"persist": "none|instructions|skill"}`）
- `GET /api/overview` — 大盘聚合
- `GET /api/analytics/*` — 热力图 / 模型对比 / 项目成本 / 任务×模型
- `GET /api/harness/suggestions` / `POST /api/harness/generate` — 防呆规则与模型建议
- `POST /api/harness/classify` / `POST /api/harness/verify` / `POST /api/harness/assemble` — 根因分类 / 静态确认 / 推荐组装
- `POST /api/harness/suggestions/:id/install` / `POST /api/harness/installations/:id/uninstall` — 安装与撤销
- `GET /api/harness/effectiveness` — 采纳效果追踪（前后对比 + 三态）
- `GET /api/events` — SSE 实时事件
- `POST /api/scan` — 手动全量扫描

## 技术栈

TypeScript · Hono · better-sqlite3 · chokidar · Vue 3 · Vite · Lucide 图标 · Space Grotesk / IBM Plex 字体
