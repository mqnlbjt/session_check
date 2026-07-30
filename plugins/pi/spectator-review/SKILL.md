---
name: spectator-review
description: 复盘当前会话的表现并上传到 spectator 观测站。触发词：复盘、复盘这个会话、review 一下这次会话、这次做得怎么样、spectator。
---

# spectator-review 会话复盘

把当前会话结构化复盘并上传到 spectator（默认 http://localhost:8321）。spectator 只有对话文本，而你有完整现场（repo 状态、git 历史、工具执行结果）——复盘时请利用这些上下文，不要只凭印象。

## 步骤

1. **找到当前会话 id**（`<SKILL_DIR>` 替换为本 SKILL.md 所在目录）：

```bash
bash <SKILL_DIR>/spectator-plugin.sh find-session pi
```

输出为空： spectator 可能还没收录到这个会话（watch 有 ~1s 延迟），等几秒重试；仍为空就告诉用户 spectator 服务未运行（`systemctl --user status spectator`），停止后续步骤。

2. **拉取对话记录**（id 需要 URL 编码，含 `:`）：

```bash
curl -s "http://localhost:8321/api/sessions/$(python3 -c 'import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1],safe=""))' "$SID")/messages?limit=2000"
```

3. **按维度分析**：
   - `verdict`：good / mixed / problematic——任务是否高质量完成
   - 返工点（rework）：哪几轮被推翻重来，根因是什么
   - 用户纠正（correction）：用户打断/纠正了几次，各自指向什么问题
   - 需求理解（misunderstanding）：有没有跑偏，何时、如何纠正回来的
   - 做得好（good_practice）：值得保持的做法
   - 可复用经验（lesson）：值得写进 memory/skill 的教训——若有，顺手调用 memory/skill 工具沉淀

4. **上传复盘**：

```bash
bash <SKILL_DIR>/spectator-plugin.sh post-review <<'JSON'
{
  "session_id": "<第1步的 id>",
  "source": "pi-plugin",
  "model": "<你当前的模型>",
  "verdict": "good|mixed|problematic",
  "summary": "一段话总结这次任务做得怎么样",
  "findings": [
    {"type": "rework|correction|misunderstanding|good_practice|lesson|risk", "detail": "具体描述", "evidence": "可选：第几轮/哪条消息"}
  ]
}
JSON
```

5. 用一两句话告诉用户复盘结论和已上传的事实。
