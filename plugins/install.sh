#!/usr/bin/env bash
# spectator agent 插件一键安装/卸载
# 用法:
#   ./install.sh            安装到检测到的所有 agent
#   ./install.sh uninstall  卸载
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MODE="${1:-install}"
HOME_DIR="${HOME}"

log()  { printf '\033[32m[+]\033[0m %s\n' "$*"; }
warn() { printf '\033[33m[-]\033[0m %s\n' "$*"; }

install_pi() {
  local dst="$HOME_DIR/.pi/agent/skills/spectator-review"
  mkdir -p "$dst"
  cp "$SRC/pi/spectator-review/SKILL.md" "$SRC/pi/spectator-review/spectator-plugin.sh" "$dst/"
  chmod +x "$dst/spectator-plugin.sh"
  log "pi        → $dst"
}

install_claude() {
  local dst="$HOME_DIR/.claude/skills/spectator-review"
  mkdir -p "$dst"
  cp "$SRC/claude-code/spectator-review/SKILL.md" "$SRC/claude-code/spectator-review/spectator-plugin.sh" "$dst/"
  chmod +x "$dst/spectator-plugin.sh"
  log "claude    → $dst"
}

install_codex() {
  local dir="$HOME_DIR/.codex/spectator"
  local agents_md="$HOME_DIR/.codex/AGENTS.md"
  mkdir -p "$dir"
  cp "$SRC/shared/spectator-plugin.sh" "$dir/"
  chmod +x "$dir/spectator-plugin.sh"
  # 幂等：有标记块就替换，没有就追加
  if [ -f "$agents_md" ] && grep -q '<!-- spectator:start -->' "$agents_md"; then
    python3 - "$agents_md" "$SRC/codex/AGENTS.snippet.md" <<'EOF'
import re, sys
path, snippet = sys.argv[1], sys.argv[2]
text = open(path).read()
block = open(snippet).read().strip()
text = re.sub(r'<!-- spectator:start -->.*?<!-- spectator:end -->', block, text, flags=re.S)
open(path, 'w').write(text)
EOF
    log "codex     → $agents_md (已更新标记块)"
  else
    { echo; cat "$SRC/codex/AGENTS.snippet.md"; } >> "$agents_md"
    log "codex     → $agents_md (已追加标记块)"
  fi
}

uninstall_pi()     { rm -rf "$HOME_DIR/.pi/agent/skills/spectator-review" && log "pi 已卸载"; }
uninstall_claude() { rm -rf "$HOME_DIR/.claude/skills/spectator-review" && log "claude 已卸载"; }
uninstall_codex() {
  rm -rf "$HOME_DIR/.codex/spectator"
  local agents_md="$HOME_DIR/.codex/AGENTS.md"
  if [ -f "$agents_md" ] && grep -q '<!-- spectator:start -->' "$agents_md"; then
    python3 - "$agents_md" <<'EOF'
import re, sys
path = sys.argv[1]
text = open(path).read()
text = re.sub(r'\n*<!-- spectator:start -->.*?<!-- spectator:end -->\n*', '\n', text, flags=re.S)
open(path, 'w').write(text)
EOF
  fi
  log "codex 已卸载"
}

if [ "$MODE" = "uninstall" ]; then
  uninstall_pi; uninstall_claude; uninstall_codex
  exit 0
fi

# 按 agent 是否存在安装
[ -d "$HOME_DIR/.pi/agent" ]   && install_pi     || warn "未检测到 pi，跳过"
[ -d "$HOME_DIR/.claude" ]     && install_claude || warn "未检测到 claude，跳过"
[ -d "$HOME_DIR/.codex" ]      && install_codex  || warn "未检测到 codex，跳过"

log "完成。在任意会话里说「复盘这个会话」即可触发。"
