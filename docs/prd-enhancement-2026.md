# PRD: Spectator 功能增强（搜索 / 信号 / 治理 / 分析）

> 日期：2026-07-31 · 状态：ready-for-agent · 前置：grill-me 已对齐（决策见「Implementation Decisions」）

## Problem Statement

Spectator 已采集 1226 个会话、13.4 万条消息（304MB），但数据价值没有释放：

1. **搜不到**：搜索只能匹配会话标题和项目路径，消息正文（讨论过的方案、踩过的坑）无法检索，"上次哪个会话讨论过 X"答不了。
2. **复盘是摆设**：1226 个会话只有 4 条复盘（0.3%），手动点复盘不会发生；会话质量（被用户纠正几次、有没有返工）完全不可见。
3. **数据只涨不治**：db 304MB 且持续增长，其中 75% 是工具输出，长期看不可持续。
4. **看不到模式**：什么时候用得最多、哪个模型又贵又差、哪个项目烧 token，这些跨会话洞察都没有。

## Solution

四期增强，每期独立交付、独立验收：

1. **全文搜索**：FTS5 索引消息正文（人话+命令），全局搜索页，点击跳转定位到会话内消息。
2. **返工信号检测**：纯规则识别用户纠正/返工语句，给会话打质量分，列表和大盘可见。
3. **数据治理**：90 天前的会话清空工具输出（保留人话+元数据+搜索索引），定期 VACUUM；会话可导出 Markdown。
4. **分析深化**：使用热力图、模型对比（成本/TPS/返工分）、项目成本榜、成本 vs git commit 并排曲线。

## User Stories

### 期 1：全文搜索
1. As a 用户, I want 按关键词搜所有会话的消息正文, so that 能找到"上次讨论过 X"的会话
2. As a 用户, I want 搜索结果按时间倒序并显示消息片段+关键词高亮, so that 快速判断是不是我要找的
3. As a 用户, I want 点击搜索结果跳转到该会话并定位到对应消息, so that 直接看上下文
4. As a 用户, I want 搜索结果带 agent/项目/时间过滤, so that 缩小范围
5. As a 用户, I want 工具入参（bash 命令等）也能被搜到, so that 能找到"上次那个命令怎么写的"
6. As a 用户, I want 搜索在历史数据上也能用（一次性回填）, so that 不是只对以后会话生效
7. As a 用户, I want 新消息入库时索引自动更新, so that 搜索永远是最新的

### 期 2：返工信号检测
8. As a 用户, I want 系统自动识别用户消息里的纠正/返工信号（"不对""重来""我不是说"）, so that 不用 LLM 就能评估会话质量
9. As a 用户, I want 会话列表显示每个会话的纠正次数/质量分, so that 一眼看出哪些会话不顺
10. As a 用户, I want 纠正信号能点击定位到对应的用户消息, so that 看当时发生了什么
11. As a 用户, I want 大盘上有返工率趋势, so that 看 agent 使用质量的整体走向
12. As a 用户, I want 信号规则可配置（词表文件）, so that 误报可以自行调

### 期 3：数据治理
13. As a 用户, I want 90 天前的会话自动清空工具输出, so that db 体积可控
14. As a 用户, I want 清理后会话的人话、元数据、搜索索引仍然完整, so that 老会话还能搜还能读
15. As a 用户, I want 清理任务定期自动跑且有日志（清了多少条、省了多少空间）, so that 不用手动维护
16. As a 用户, I want 清理后执行 VACUUM 真正回收磁盘, so that 空间是真的省下来
17. As a 用户, I want 单个会话能导出 Markdown, so that 复盘/分享用

### 期 4：分析深化
18. As a 用户, I want 小时×星期的使用热力图, so that 看自己最活跃的时间段
19. As a 用户, I want 模型对比表（成本/TPS/返工分/会话数）, so that 决定以后用什么模型
20. As a 用户, I want 项目成本榜, so that 知道 token 都烧在哪
21. As a 用户, I want 项目维度的成本曲线和 git commit 曲线并排展示, so that 自己判断投入产出（系统不做强行归属）

## Implementation Decisions

### 全局
- **实施顺序**：期 1 → 2 → 3 → 4，每期合并 main 后再开下一期
- **新分支**：每期一个 feature 分支（`feat/fts-search` 等），默认 main
- **测试基建**：引入 vitest，测试统一打 HTTP API 层（单接缝），用临时 db + fixture 消息，不测内部函数

### 期 1：全文搜索
- 新增 FTS5 虚表 `messages_fts`，列：`message_id`(UNINDEXED)、`session_id`(UNINDEXED)、`content`
- **索引范围**（grill 决策）：只索引 `text` block（user/assistant）和 `tool_call` 的 input 文本；`thinking`、`tool_result` output 不索引
  - 依据：tool output 占 159MB/213MB（75%），排除后索引源仅 ~50MB
- `tokenize='unicode61'`；中文按 bigram 效果差，用 `tokenize='trigram'` 保证中文可搜（决策点，见 Further Notes）
- ingest 链路同步写入：`persist.ts` 写 messages 的同事务内写 FTS
- 一次性回填：脚本遍历老消息重建索引（`INSERT INTO messages_fts(messages_fts) VALUES('rebuild')` 或逐条），13 万条约几分钟
- API：`GET /api/search?q=&agent=&project=&from=&to=&limit=&offset=`，返回消息片段（snippet() 高亮）、所属会话信息
- 前端：全局搜索页（顶部导航入口），结果项点击跳 `?session=<id>&msg=<seq>`，ConversationView 支持定位滚动+高亮

### 期 2：返工信号检测
- 新增表 `signals`：`id, session_id, message_id, rule, snippet, ts`
- 规则库独立文件 `signal-rules.ts`（仿照 `rules.ts` 的 Rule 结构），初始规则：
  - 纠正类：`不对|错了|重来|重新|我不是说|我的意思是|你理解错|别改|撤销|回退`
  - 挫折类：`怎么又|还是不行|又挂了|算了`（单独 severity，不计入返工分或降权）
  - 只扫 `role=user` 的 text block，排除 tool_result
- 质量分：`score = correction_count`（简单计数，先不上加权），会话列表加列展示
- ingest 时同步检测（和 risks 同一时机），老数据回填一次
- 大盘 `/api/overview` 加返工率指标（有纠正的会话占比，按周聚合）

### 期 3：数据治理
- 清理任务 `src/janitor.ts`：找 `started_at < now-90d` 的会话，把其 messages 的 `blocks_json` 中 `tool_result` block 的 output 置空（保留 block 结构），记录清理日志表 `janitor_log(run_at, sessions, messages, bytes_freed)`
- **不清** `text`/`tool_call`，不影响 FTS 索引和信号检测（与期 1/2 决策天然兼容）
- 触发：serve 启动时跑一次 + 之后每 24h 一次；`npm run janitor` 手动触发
- 清理后 `VACUUM`（注意 WAL 模式先 checkpoint）
- 导出：`GET /api/sessions/:id/export.md` 生成 Markdown（frontmatter 元数据 + 消息流），前端会话页加导出按钮

### 期 4：分析深化
- 热力图：`GET /api/analytics/heatmap` 按 strftime 小时×星期聚合消息数/token，前端热力图组件（纯 CSS grid）
- 模型对比：`GET /api/analytics/models` 按 model 聚合 会话数/成本/TPS/平均返工分（依赖期 2）
- 项目成本榜：`GET /api/analytics/projects` 按 project_path 聚合成本/token/会话数
- 成本 vs commit：项目详情页两条曲线并排——成本曲线用现有数据，commit 曲线按需 `git log`（懒加载，超时 5s，失败则只显示成本曲线）；**不做会话级归属**（grill 决策）
- 分析页作为独立 tab，不进现有大盘页避免过载

## Testing Decisions

- **什么是好测试**：只测外部行为（HTTP API 请求/响应），不测内部函数；fixture 用真实归一化消息结构
- **测试接缝**：Hono app 单接缝——`app.request()` 直接打 API，better-sqlite3 用 `:memory:` 或临时文件 db
- **覆盖点**：
  - 期 1：FTS 写入（ingest 后可搜到）、中文搜索、搜索过滤、回填幂等
  - 期 2：信号规则命中/不误报（构造用户消息样例）、质量分聚合
  - 期 3：janitor 清理边界（89 天不清/91 天清）、清理后 text 保留、导出 Markdown 格式
  - 期 4：聚合 SQL 正确性（固定 fixture 断言数值）
- **prior art**：仓库目前无测试（package.json test 脚本是占位），本期建立基建

## Out of Scope

- 自动 LLM 复盘（grill 决策：复盘保持手动触发，信号检测先行验证）
- 工具输出内容搜索（grill 决策：不索引 tool_result；如未来需要可开 hybrid 降级查询）
- commit 到会话的归属算法（grill 决策：只并排展示）
- 主动告警（飞书/系统通知、成本预算）——上轮讨论的第 3 项，本次未选
- 访问鉴权、多机汇聚
- 移动端适配

## Further Notes

- **中文分词决策点**：FTS5 的 `unicode61` 对中文按整段切（无空格不分词），`trigram` 支持子串匹配但索引更大（~50MB 源 → 估 80-120MB 索引）。实现时先 trigram，回填后实测体积，超 150MB 再评估 jieba 分词扩展。
- 信号检测误报风险：用户引用别人的话、代码里的字符串可能误命中。先跑回填看 Top 命中，误报多就收紧规则再上线。
- janitor 清 90 天是按 `started_at` 还是 `ended_at`：用 `COALESCE(ended_at, started_at)`，避免长跑会话被误清。
- 四期的 db schema 变更逐期叠加（FTS 虚表 → signals 表 → janitor_log 表），都用 `IF NOT EXISTS` 轻迁移风格，与现有 db.ts 一致。
