<!-- spectator:start -->
## spectator 会话复盘（spectator-review）

当用户让你"复盘这个会话 / review 这次会话"时，把当前会话结构化复盘并上传到 spectator（默认 http://localhost:8321）。复盘时利用你对任务的完整上下文（repo 状态、git 历史），不要只凭印象。

步骤：

1. 找到当前会话 id（spectator-plugin.sh 在 ~/.codex/spectator/ 下）：
   `bash ~/.codex/spectator/spectator-plugin.sh find-session codex`
   输出为空说明 spectator 未收录该会话或服务未运行（`systemctl --user status spectator`），告知用户并停止。
2. 拉取对话：`GET http://localhost:8321/api/sessions/<id URL编码>/messages?limit=2000`
3. 按维度分析：verdict（good/mixed/problematic）、返工点、用户纠正次数与内容、需求理解偏差、可复用经验。
4. 上传：`bash ~/.codex/spectator/spectator-plugin.sh post-review`，stdin 为 JSON：
   `{"session_id":"...","source":"codex-plugin","model":"...","verdict":"...","summary":"一段话","findings":[{"type":"rework|correction|misunderstanding|good_practice|lesson|risk","detail":"..."}]}`
5. 用一两句话告诉用户复盘结论和已上传的事实。
<!-- spectator:end -->
