<script setup lang="ts">
import { computed, ref } from 'vue'
import { fmtClock, type Block, type Message } from '../api'
import { ChevronDown, ChevronRight, Brain, TerminalSquare } from 'lucide-vue-next'

const props = defineProps<{ message: Message }>()

const expanded = ref(false)

const ROLE_LABEL: Record<string, string> = {
  user: 'USR',
  assistant: 'AGT',
  tool: 'TOOL',
  system: 'SYS',
}

// 块太多或太长时默认折叠，保持日志流的可扫读性
const isCollapsible = computed(() =>
  props.message.blocks.some((b) =>
    b.type === 'thinking' ||
    b.type === 'tool_result' && (b.output?.length ?? 0) > 400 ||
    b.type === 'tool_call' && JSON.stringify(b.input ?? '').length > 300
  )
)

function toolInputSummary(b: Block): string {
  const s = typeof b.input === 'string' ? b.input : JSON.stringify(b.input)
  if (!s) return ''
  // 提取最有辨识度的一个字段当摘要
  try {
    const obj = typeof b.input === 'object' ? b.input as any : JSON.parse(s)
    const key = ['command', 'path', 'pattern', 'query', 'file_path', 'url'].find((k) => obj?.[k])
    if (key) return String(obj[key]).slice(0, 90)
  } catch { /* 非 JSON 就截断 */ }
  return s.slice(0, 90)
}
</script>

<template>
  <div class="msg" :class="[message.role, { expanded }]">
    <span class="ts mono">{{ fmtClock(message.ts) }}</span>
    <span class="role mono" :class="message.role">{{ ROLE_LABEL[message.role] }}</span>

    <div class="body">
      <span v-if="message.tps" class="tps mono">~{{ message.tps }} tok/s</span>
      <template v-for="(b, i) in message.blocks" :key="i">
        <!-- 正文 -->
        <p v-if="b.type === 'text'" class="text">{{ b.text }}</p>

        <!-- 思考：默认折叠 -->
        <div v-else-if="b.type === 'thinking'" class="thinking">
          <button class="fold mono" @click="expanded = !expanded">
            <component :is="expanded ? ChevronDown : ChevronRight" class="lucide" />
            <Brain class="lucide" /> thinking
          </button>
          <pre v-if="expanded" class="mono">{{ b.text }}</pre>
        </div>

        <!-- 工具调用：一行摘要，可展开 -->
        <div v-else-if="b.type === 'tool_call'" class="tool-call">
          <button class="fold mono" @click="expanded = !expanded">
            <component :is="expanded ? ChevronDown : ChevronRight" class="lucide" />
            <TerminalSquare class="lucide" /> <span class="tool-name">{{ b.name }}</span>
            <span v-if="!expanded" class="summary">{{ toolInputSummary(b) }}</span>
          </button>
          <pre v-if="expanded" class="mono">{{ typeof b.input === 'string' ? b.input : JSON.stringify(b.input, null, 2) }}</pre>
        </div>

        <!-- 工具结果 -->
        <div v-else-if="b.type === 'tool_result'" class="tool-result" :class="{ error: b.isError }">
          <button v-if="isCollapsible" class="fold mono" @click="expanded = !expanded">
            <component :is="expanded ? ChevronDown : ChevronRight" class="lucide" />
            {{ b.name ?? 'result' }}{{ b.isError ? ' · 错误' : '' }}
          </button>
          <pre class="mono" :class="{ clipped: !expanded && isCollapsible }">{{ b.output }}</pre>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.msg {
  display: grid;
  grid-template-columns: 62px 40px 1fr;
  gap: 10px;
  padding: 7px 20px 7px 14px;
  border-left: 2px solid transparent;
  align-items: baseline;
}
.msg:hover { background: var(--panel); }
.msg.user { border-left-color: var(--amber); background: rgba(232, 163, 61, 0.04); }

.ts { font-size: 11px; color: var(--faint); }
.role { font-size: 10px; font-weight: 500; letter-spacing: 0.05em; }
.role.user { color: var(--amber); }
.role.assistant { color: var(--text); }
.role.tool { color: var(--dim); }
.role.system { color: var(--faint); }

.mono { font-family: var(--mono); }
.body { min-width: 0; }

.tps {
  float: right;
  font-size: 10px;
  color: var(--faint);
}

.text { white-space: pre-wrap; word-break: break-word; font-size: 13.5px; }

.fold {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  background: none;
  border: none;
  color: var(--dim);
  font-size: 11px;
  padding: 2px 0;
  text-align: left;
  transition: color 0.2s var(--ease-out);
}
.fold .lucide { width: 11px; height: 11px; }
.fold:hover { color: var(--text); }

.thinking pre, .tool-call pre, .tool-result pre {
  margin-top: 4px;
  padding: 8px 10px;
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 4px;
  font-size: 12px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 420px;
  overflow: auto;
}
.thinking pre { color: var(--dim); }

.tool-name { color: var(--claude); font-weight: 500; }
.summary { color: var(--faint); margin-left: 6px; }

.tool-result pre.clipped {
  max-height: 72px;
  overflow: hidden;
  mask-image: linear-gradient(to bottom, black 40%, transparent);
}
.tool-result.error pre { border-color: rgba(225, 90, 90, 0.4); color: #E8A0A0; }

@media (max-width: 720px) {
  .msg { grid-template-columns: 44px 1fr; }
  .ts { display: none; }
}
</style>
