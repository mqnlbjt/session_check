#!/usr/bin/env bash
# spectator 插件辅助脚本：帮 agent 找到自己的会话并回传复盘结果
# 用法:
#   spectator-plugin.sh find-session <pi|claude|codex> [cwd]   输出会话 id
#   spectator-plugin.sh post-review                            从 stdin 读 JSON 上传
set -euo pipefail

BASE="${SPECTATOR_URL:-http://localhost:8321}"
cmd="${1:-}"

case "$cmd" in
  find-session)
    agent="${2:?用法: find-session <pi|claude|codex> [cwd]}"
    cwd="${3:-$PWD}"
    curl -fsS --get "$BASE/api/sessions" \
      --data-urlencode "agent=$agent" \
      --data-urlencode "q=$cwd" \
      --data-urlencode "limit=1" \
      | python3 -c "import sys,json; rows=json.load(sys.stdin)['rows']; print(rows[0]['id'] if rows else '')"
    ;;
  post-review)
    curl -fsS -X POST "$BASE/api/reviews" \
      -H 'Content-Type: application/json' \
      -d @-
    echo
    ;;
  *)
    echo "未知命令: $cmd" >&2
    exit 1
    ;;
esac
