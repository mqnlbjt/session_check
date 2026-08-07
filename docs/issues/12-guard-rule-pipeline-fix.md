# Issue #12: 防呆规则生成链路修复（P0-P4）

> Parent: 期6 改进清单（2026-08-04/05 grill 决策）；续 docs/issues/00-11

## What to build

修现有防呆规则生成链路（signal-rules → harness 聚合 → LLM 生成 → persist）的五个漏：

- **P0 去重闭环**：dup 查询覆盖 dismissed + adopted——用户否掉/已采纳的规则不再重复生成；采纳内容记入排除集
- **P1 时间窗**：topCorrectionSignals 改 90 天滚动窗，旧模式不再霸榜；采纳后信号消失则同主题规则自然停发
- **P2 证据升级**：snippet 截取匹配点前后各 40 字符（而非消息开头 60 字符）；取样本时 join 前一条 assistant 消息摘要（截 200 字）放进 prompt——LLM 看到「agent 做了什么 → 用户纠正什么」
- **P3 误报治理**：排除第一人称纠正（`我(的)?错|我搞错` 类）；MACHINE_MARKERS 补 prompt 模板开头（`你是.{2,10}专家` 类）
- **P4 frustration 佐证**：give-up 信号不进频次排序，但 prompt 附 1-2 条样本作痛点佐证

## Acceptance criteria

- [x] dismissed/adopted 的规则主题不再重复出现在新一批 pending 中
- [x] 90 天前的旧信号不参与计数排序
- [x] 生成 prompt 中包含匹配点上下文 snippet + 前一条 assistant 摘要
- [x] 第一人称纠正与 subagent 任务书模板不再被采集为信号
- [x] 现有 harness/signals 测试全绿，新增用例覆盖上述行为

## Blocked by

- None — can start immediately
