<script setup lang="ts">
import { fmtTime, fmtTokens, type SessionRow } from '../api'
import SparkBar from './SparkBar.vue'

defineProps<{
  session: SessionRow
  active: boolean
}>()

const emit = defineEmits<{ select: [id: string] }>()

const AGENT_LABEL: Record<string, string> = { pi: 'PI', claude: 'CC', codex: 'CX' }
</script>

<template>
  <button
    class="row"
    :class="{ active }"
    @click="emit('select', session.id)"
  >
    <div class="top">
      <span class="badge" :class="session.agent">{{ AGENT_LABEL[session.agent] ?? session.agent }}</span>
      <span class="title">{{ session.title ?? '(空会话)' }}</span>
    </div>
    <div class="meta">
      <span>{{ session.message_count }} 消息</span>
      <span v-if="session.subagent_count" class="subs">▸ {{ session.subagent_count }} sub</span>
      <span v-if="session.model" class="model mono">{{ session.model }}</span>
      <span v-if="session.output_tokens" class="mono">{{ fmtTokens(session.output_tokens) }} tok</span>
      <span class="time mono">{{ fmtTime(session.started_at) }}</span>
    </div>
    <SparkBar :data="session.spark ?? []" />
  </button>
</template>

<style scoped>
.row {
  display: block;
  width: 100%;
  text-align: left;
  background: transparent;
  border: none;
  border-left: 2px solid transparent;
  border-bottom: 1px solid var(--line);
  padding: 10px 14px 8px;
  color: var(--text);
  transition: background 0.12s;
}
.row:hover { background: var(--panel-2); }
.row.active { background: var(--panel-2); border-left-color: var(--amber); }

.top { display: flex; align-items: baseline; gap: 8px; min-width: 0; }
.badge {
  font-family: var(--mono);
  font-size: 10px;
  font-weight: 500;
  letter-spacing: 0.06em;
  padding: 1px 5px;
  border-radius: 3px;
  flex-shrink: 0;
}
.badge.pi { color: var(--pi); background: rgba(79, 195, 247, 0.12); }
.badge.claude { color: var(--claude); background: rgba(232, 131, 58, 0.12); }
.badge.codex { color: var(--codex); background: rgba(111, 207, 151, 0.12); }

.title {
  font-size: 13px;
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.meta {
  display: flex;
  gap: 10px;
  margin: 3px 0 6px;
  font-size: 11px;
  color: var(--dim);
}
.meta .subs { color: var(--amber); }
.model {
  max-width: 110px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  color: var(--faint);
}
.mono { font-family: var(--mono); }
.time { margin-left: auto; color: var(--faint); }
</style>
