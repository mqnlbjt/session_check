# Issue #13: 信号确认层（ingest 确定性检查）

> Parent: 期6 改进清单（grill Q8：确定性层自动、零成本、ingest 时跑）

## What to build

ingest 时为每条纠正信号自动打确认标记（纯 SQL/规则，零 LLM 成本）：

- **实质动作确认**：信号消息的前一条 assistant 有无实质动作（edit/write/bash 等工具调用）——用户纠正的是 agent 的行为还是纯闲聊
- **行为佐证**：同会话中该类信号的重复出现情况（项目级重复是 #14 根因聚合的事，不进此层）
- **置信度档位**：基于上述两项给信号标 confirmed / unconfirmed / likely-noise
- 确认状态落库（signals 表加字段），API 可查询；回填脚本处理存量信号

## Acceptance criteria

- [x] 新 ingest 的纠正信号自动带确认状态
- [x] 存量信号可一次性回填确认状态
- [x] likely-noise 信号（前一条无实质动作、单发）可被 API 过滤
- [x] 测试覆盖：有实质动作→confirmed；无动作+单发→降权

## Blocked by

- #12 防呆规则生成链路修复（同一条采集/生成管线，避免冲突）
