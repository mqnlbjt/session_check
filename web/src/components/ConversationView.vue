<script setup lang="ts">
import { onMounted, ref, watch } from 'vue'
import { api, fmtTokens, type Message, type Risk, type SessionRow } from '../api'
import MessageItem from './MessageItem.vue'

const props = defineProps<{ sessionId: string; liveTick?: number }>()

const session = ref<SessionRow | null>(null)
const messages = ref<Message[]>([])
const risks = ref<Risk[]>([])
const subs = ref<SessionRow[]>([])
const loading = ref(true)
const error = ref('')
const viewParent = ref(false) // 查看的是 subagent 时，提供回到父会话的入口

async function load() {
  loading.value = true
  error.value = ''
  try {
    const data = await api.messages(props.sessionId)
    session.value = data.session
    messages.value = data.messages
    risks.value = (data as any).risks ?? []
    // 主会话：拉取它的 subagent 列表；subagent：不需要
    if (!data.session.parent_id && data.session.subagent_count > 0) {
      subs.value = (await api.sessions({ parent: data.session.id, limit: 100 })).rows
    } else {
      subs.value = []
    }
  } catch (e: any) {
    error.value = e?.message ?? '加载失败'
  } finally {
    loading.value = false
  }
}

onMounted(load)
watch(() => props.sessionId, load)

// 实时推送：当前会话有新消息入库时，只增量刷新消息流，不动头部
watch(() => props.liveTick, async () => {
  if (!props.sessionId) return
  try {
    const data = await api.messages(props.sessionId)
    messages.value = data.messages
  } catch { /* 静默失败，下次事件再试 */ }
})

const emit = defineEmits<{ select: [id: string] }>()
</script>

<template>
  <div class="conv">
    <header v-if="session" class="head">
      <div class="crumb">
        <button
          v-if="session.parent_id"
          class="parent mono"
          @click="emit('select', session.parent_id)"
        >← 父会话</button>
        <span class="badge mono" :class="session.agent">{{ session.agent }}</span>
        <span class="path mono">{{ session.project_path }}</span>
      </div>
      <h1 class="title">{{ session.title ?? '(空会话)' }}</h1>
      <div class="stats mono">
        <span>{{ session.message_count }} 消息</span>
        <span v-if="session.model">{{ session.model }}</span>
        <span v-if="session.input_tokens">in {{ fmtTokens(session.input_tokens) }}</span>
        <span v-if="session.output_tokens">out {{ fmtTokens(session.output_tokens) }}</span>
        <span v-if="session.avg_tps" class="tps">~{{ session.avg_tps }} tok/s</span>
      </div>
      <div v-if="risks.length" class="risks">
        <span
          v-for="(r, i) in risks" :key="i"
          class="risk-chip mono"
          :class="r.severity"
          :title="r.snippet ?? ''"
        >{{ r.rule }}</span>
      </div>
      <div v-if="subs.length" class="subs">
        <span class="subs-label mono">SUBAGENTS</span>
        <button
          v-for="s in subs" :key="s.id"
          class="sub mono"
          @click="emit('select', s.id)"
        >{{ s.id.split(':sub:')[1] ?? s.id }} · {{ s.message_count }} 消息</button>
      </div>
    </header>

    <div v-if="loading" class="state">加载中…</div>
    <div v-else-if="error" class="state">出错了：{{ error }}</div>
    <div v-else-if="!messages.length" class="state">这个会话还没有消息记录</div>

    <div v-else class="flow">
      <MessageItem v-for="m in messages" :key="m.seq" :message="m" />
    </div>
  </div>
</template>

<style scoped>
.conv { height: 100%; overflow-y: auto; }

.head {
  position: sticky;
  top: 0;
  z-index: 2;
  background: rgba(16, 19, 24, 0.92);
  backdrop-filter: blur(8px);
  border-bottom: 1px solid var(--line);
  padding: 14px 20px 12px;
}
.crumb { display: flex; align-items: center; gap: 10px; margin-bottom: 6px; }
.parent {
  background: none;
  border: 1px solid var(--line);
  border-radius: 4px;
  color: var(--amber);
  font-size: 11px;
  padding: 2px 8px;
}
.parent:hover { border-color: var(--amber); }
.badge { font-size: 10px; letter-spacing: 0.08em; text-transform: uppercase; }
.badge.pi { color: var(--pi); }
.badge.claude { color: var(--claude); }
.badge.codex { color: var(--codex); }
.path { font-size: 11px; color: var(--faint); }

.title { font-size: 17px; font-weight: 600; line-height: 1.35; }

.stats {
  display: flex;
  gap: 14px;
  margin-top: 6px;
  font-size: 11px;
  color: var(--dim);
}
.stats .tps { color: var(--amber); }

.subs { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; align-items: center; }
.risks { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
.risk-chip {
  font-size: 10px;
  padding: 2px 8px;
  border-radius: 4px;
  border: 1px solid;
}
.risk-chip.high { color: var(--danger); border-color: rgba(225, 90, 90, 0.5); background: rgba(225, 90, 90, 0.08); }
.risk-chip.medium { color: var(--amber); border-color: rgba(232, 163, 61, 0.4); background: rgba(232, 163, 61, 0.06); }
.subs-label { font-size: 10px; color: var(--faint); letter-spacing: 0.08em; }
.sub {
  background: var(--panel-2);
  border: 1px solid var(--line);
  border-radius: 4px;
  color: var(--dim);
  font-size: 11px;
  padding: 2px 8px;
}
.sub:hover { color: var(--amber); border-color: var(--amber); }

.state { padding: 60px 20px; text-align: center; color: var(--dim); }
.flow { padding: 8px 0 40px; }
</style>
