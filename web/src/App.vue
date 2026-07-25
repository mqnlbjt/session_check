<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch } from 'vue'
import { api, fmtTokens, type SessionRow, type Stats } from './api'
import SessionItem from './components/SessionItem.vue'
import ConversationView from './components/ConversationView.vue'

const sessions = ref<SessionRow[]>([])
const total = ref(0)
const stats = ref<Stats | null>(null)
const selected = ref<string | null>(null)
const q = ref('')
const agentFilter = ref('')
const loading = ref(false)
const loadingMore = ref(false)
const liveTick = ref(0) // 当前打开的会话有新消息时递增，驱动对话流刷新

const AGENTS = [
  { value: '', label: '全部' },
  { value: 'pi', label: 'pi' },
  { value: 'claude', label: 'claude' },
  { value: 'codex', label: 'codex' },
]

async function load(reset = true, silent = false) {
  if (reset && !silent) { loading.value = true; sessions.value = [] }
  try {
    const data = await api.sessions({
      agent: agentFilter.value || undefined,
      q: q.value || undefined,
      limit: 50,
      offset: reset ? 0 : sessions.value.length,
    })
    total.value = data.total
    sessions.value = reset ? data.rows : [...sessions.value, ...data.rows]
  } finally {
    loading.value = false
    loadingMore.value = false
  }
}

function loadMore() {
  if (loadingMore.value || sessions.value.length >= total.value) return
  loadingMore.value = true
  load(false)
}

// 搜索防抖
let timer: ReturnType<typeof setTimeout> | null = null
watch([q, agentFilter], () => {
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => load(true), 300)
})

// SSE 实时事件：新消息入库后静默刷新列表/统计；若正好是打开的会话则刷新对话流
let es: EventSource | null = null
let refreshTimer: ReturnType<typeof setTimeout> | null = null
function onIngestEvent(sessionPk: string) {
  if (refreshTimer) clearTimeout(refreshTimer)
  refreshTimer = setTimeout(() => {
    load(true, true)
    api.stats().then((s) => { stats.value = s })
    if (sessionPk === selected.value) liveTick.value++
  }, 1200)
}

function onScroll(e: Event) {
  const el = e.target as HTMLElement
  if (el.scrollTop + el.clientHeight >= el.scrollHeight - 200) loadMore()
}

function onSelect(id: string) {
  selected.value = id
}

onMounted(async () => {
  load(true)
  stats.value = await api.stats()
  es = new EventSource('/api/events')
  es.onmessage = (e) => {
    try {
      const d = JSON.parse(e.data)
      if (d.type === 'ingest') onIngestEvent(d.session)
    } catch { /* 忽略坏事件 */ }
  }
})
onUnmounted(() => es?.close())
watch(sessions, (rows) => {
  if (!selected.value && rows.length) selected.value = rows[0].id
}, { once: true })

function agentStat(agent: string) {
  return stats.value?.byAgent.find((a) => a.agent === agent)
}
</script>

<template>
  <div class="layout">
    <!-- 顶栏：观测状态行 -->
    <header class="topbar">
      <div class="brand">
        <span class="dot" aria-hidden="true"></span>
        <span class="wordmark mono">SPECTATOR</span>
      </div>
      <div class="topstats mono" v-if="stats">
        <span v-for="a in ['pi', 'claude', 'codex']" :key="a" class="tstat" :class="a">
          {{ a }} {{ agentStat(a)?.sessions ?? 0 }}
        </span>
        <span class="sep">·</span>
        <span>{{ total.toLocaleString() }} 会话</span>
      </div>
    </header>

    <!-- 左栏：会话列表 -->
    <aside class="sidebar">
      <div class="controls">
        <input
          v-model="q"
          class="search"
          type="search"
          placeholder="搜索标题 / 项目路径…"
          aria-label="搜索会话"
        />
        <div class="chips" role="tablist" aria-label="按 agent 筛选">
          <button
            v-for="a in AGENTS" :key="a.value"
            class="chip mono"
            :class="{ on: agentFilter === a.value }"
            role="tab"
            :aria-selected="agentFilter === a.value"
            @click="agentFilter = a.value"
          >{{ a.label }}</button>
        </div>
      </div>

      <div class="list" @scroll="onScroll">
        <div v-if="loading" class="hint">扫描中…</div>
        <div v-else-if="!sessions.length" class="hint">
          没有匹配的会话。换个关键词，或确认 agent 的 session 目录已被监控。
        </div>
        <SessionItem
          v-for="s in sessions" :key="s.id"
          :session="s"
          :active="selected === s.id"
          @select="onSelect"
        />
        <div v-if="loadingMore" class="hint">加载更多…</div>
      </div>
    </aside>

    <!-- 右栏：对话查看器 -->
    <main class="main">
      <ConversationView v-if="selected" :session-id="selected" :live-tick="liveTick" @select="onSelect" />
      <div v-else class="empty">
        <p class="mono">SPECTATOR</p>
        <p>从左侧选择一个会话开始观测</p>
      </div>
    </main>
  </div>
</template>

<style scoped>
.layout {
  display: grid;
  grid-template-rows: 44px 1fr;
  grid-template-columns: 340px 1fr;
  grid-template-areas: 'top top' 'side main';
  height: 100vh;
}

/* ---- 顶栏 ---- */
.topbar {
  grid-area: top;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 16px;
  border-bottom: 1px solid var(--line);
  background: var(--panel);
}
.brand { display: flex; align-items: center; gap: 9px; }
.dot {
  width: 7px; height: 7px; border-radius: 50%;
  background: var(--amber);
  animation: pulse 2.4s ease-in-out infinite;
}
@keyframes pulse { 50% { opacity: 0.25; } }
.wordmark { font-size: 12px; font-weight: 500; letter-spacing: 0.28em; color: var(--text); }

.topstats { display: flex; gap: 14px; font-size: 11px; color: var(--dim); align-items: center; }
.tstat.pi { color: var(--pi); }
.tstat.claude { color: var(--claude); }
.tstat.codex { color: var(--codex); }
.sep { color: var(--faint); }

/* ---- 左栏 ---- */
.sidebar {
  grid-area: side;
  display: flex;
  flex-direction: column;
  border-right: 1px solid var(--line);
  background: var(--panel);
  min-height: 0;
}
.controls { padding: 12px 14px 10px; border-bottom: 1px solid var(--line); }
.search {
  width: 100%;
  background: var(--ink);
  border: 1px solid var(--line);
  border-radius: 5px;
  color: var(--text);
  font-size: 13px;
  padding: 7px 10px;
  margin-bottom: 9px;
}
.search::placeholder { color: var(--faint); }
.search:focus { border-color: var(--amber); outline: none; }

.chips { display: flex; gap: 6px; }
.chip {
  background: transparent;
  border: 1px solid var(--line);
  border-radius: 4px;
  color: var(--dim);
  font-size: 11px;
  padding: 3px 10px;
}
.chip:hover { color: var(--text); }
.chip.on { color: var(--amber); border-color: var(--amber); background: rgba(232, 163, 61, 0.08); }

.list { flex: 1; overflow-y: auto; }
.hint { padding: 24px 16px; font-size: 12px; color: var(--dim); line-height: 1.7; }

/* ---- 右栏 ---- */
.main { grid-area: main; min-width: 0; min-height: 0; }
.empty {
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  color: var(--dim);
}
.empty .mono { letter-spacing: 0.3em; font-size: 13px; color: var(--faint); }

@media (max-width: 860px) {
  .layout { grid-template-columns: 1fr; grid-template-areas: 'top' 'main'; }
  .sidebar { display: none; }
}
</style>
