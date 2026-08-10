<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch } from 'vue'
import { api, fmtTokens, type SessionRow, type Stats } from './api'
import { LayoutGrid, MessagesSquare, Search, BarChart3, Wrench } from 'lucide-vue-next'
import SessionItem from './components/SessionItem.vue'
import ConversationView from './components/ConversationView.vue'
import OverviewView from './components/OverviewView.vue'
import SearchView from './components/SearchView.vue'
import AnalyticsView from './components/AnalyticsView.vue'
import HarnessView from './components/HarnessView.vue'

const view = ref<'overview' | 'sessions' | 'search' | 'analytics' | 'harness'>('overview')
const overviewRef = ref<InstanceType<typeof OverviewView> | null>(null)

const sessions = ref<SessionRow[]>([])
const total = ref(0)
const stats = ref<Stats | null>(null)
const selected = ref<string | null>(null)
const jumpSeq = ref<number | null>(null) // 搜索结果跳转：定位到会话内某条消息
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

const NAV = [
  { key: 'overview', label: '大盘', icon: LayoutGrid },
  { key: 'sessions', label: '会话', icon: MessagesSquare },
  { key: 'search', label: '搜索', icon: Search },
  { key: 'analytics', label: '分析', icon: BarChart3 },
  { key: 'harness', label: 'Harness', icon: Wrench },
] as const

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
    overviewRef.value?.reload()
    if (sessionPk === selected.value) liveTick.value++
  }, 1200)
}

function onScroll(e: Event) {
  const el = e.target as HTMLElement
  if (el.scrollTop + el.clientHeight >= el.scrollHeight - 200) loadMore()
}

function onSelect(id: string) {
  selected.value = id
  jumpSeq.value = null
  view.value = 'sessions'
  // 同步到 URL，方便分享/刷新保持
  const url = new URL(location.href)
  url.searchParams.set('session', id)
  url.searchParams.delete('msg')
  history.replaceState(null, '', url)
}

// 搜索结果点击：打开会话并定位到对应消息
function onJump(sessionId: string, seq: number) {
  selected.value = sessionId
  jumpSeq.value = seq
  view.value = 'sessions'
  const url = new URL(location.href)
  url.searchParams.set('session', sessionId)
  url.searchParams.set('msg', String(seq))
  history.replaceState(null, '', url)
}

onMounted(async () => {
  // 支持深链：?session=<id>&msg=<seq> 直接打开会话页并定位
  const sp = new URLSearchParams(location.search)
  const deepLink = sp.get('session')
  if (deepLink) {
    view.value = 'sessions'
    selected.value = deepLink
    const msg = sp.get('msg')
    if (msg) jumpSeq.value = Number(msg)
  }
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
  <div class="layout" :class="{ 'mode-overview': view !== 'sessions' }">
    <!-- 顶栏：观测状态行 -->
    <header class="topbar">
      <div class="brand">
        <span class="dot" aria-hidden="true"></span>
        <span class="wordmark">SPECTATOR</span>
        <nav class="nav">
          <button
            v-for="n in NAV" :key="n.key"
            class="nav-btn"
            :class="{ on: view === n.key }"
            @click="view = n.key"
          >
            <component :is="n.icon" class="lucide" />
            <span>{{ n.label }}</span>
          </button>
        </nav>
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
        <div class="search-wrap">
          <Search class="lucide search-icon" />
          <input
            v-model="q"
            class="search"
            type="search"
            placeholder="搜索标题 / 项目路径…"
            aria-label="搜索会话"
          />
        </div>
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

    <!-- 右栏：对话查看器 / 大盘 -->
    <main class="main">
      <Transition name="view-fade" mode="out-in">
        <OverviewView v-if="view === 'overview'" ref="overviewRef" :key="'overview'" />
        <SearchView v-else-if="view === 'search'" @jump="onJump" :key="'search'" />
        <AnalyticsView v-else-if="view === 'analytics'" :key="'analytics'" />
        <HarnessView v-else-if="view === 'harness'" :key="'harness'" />
        <div v-else :key="'sessions'" class="sessions-pane">
          <ConversationView v-if="selected" :session-id="selected" :live-tick="liveTick" :jump-seq="jumpSeq" @select="onSelect" />
          <div v-else class="empty">
            <p class="wordmark-ghost">SPECTATOR</p>
            <p>从左侧选择一个会话开始观测</p>
          </div>
        </div>
      </Transition>
    </main>
  </div>
</template>

<style scoped>
.layout {
  display: grid;
  grid-template-rows: 52px 1fr;
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
  padding: 0 18px;
  border-bottom: 1px solid var(--line);
  background: rgba(18, 21, 28, 0.85);
  backdrop-filter: blur(10px);
}
.brand { display: flex; align-items: center; gap: 10px; }
.nav { display: flex; gap: 2px; margin-left: 22px; }
.nav-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  background: transparent;
  border: 1px solid transparent;
  border-radius: 6px;
  color: var(--dim);
  font-size: 12px;
  padding: 5px 12px;
  transition: color 0.2s var(--ease-out), background 0.2s var(--ease-out), transform 0.15s var(--spring);
}
.nav-btn:hover { color: var(--text); transform: translateY(-1px); }
.nav-btn:active { transform: scale(0.97); }
.nav-btn.on { color: var(--amber); background: var(--amber-soft); border-color: rgba(232, 163, 61, 0.3); }
.dot {
  width: 7px; height: 7px; border-radius: 50%;
  background: var(--amber);
  box-shadow: 0 0 8px rgba(232, 163, 61, 0.7);
  animation: pulse 2.4s ease-in-out infinite;
}
@keyframes pulse { 50% { opacity: 0.25; } }
.wordmark {
  font-family: var(--display);
  font-size: 13px;
  font-weight: 700;
  letter-spacing: 0.3em;
  color: var(--text);
}

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
.search-wrap { position: relative; margin-bottom: 9px; }
.search-icon {
  position: absolute;
  left: 10px;
  top: 50%;
  transform: translateY(-50%);
  color: var(--faint);
  pointer-events: none;
}
.search {
  width: 100%;
  background: var(--ink);
  border: 1px solid var(--line);
  border-radius: 6px;
  color: var(--text);
  font-size: 13px;
  padding: 8px 10px 8px 32px;
  transition: border-color 0.2s var(--ease-out);
}
.search::placeholder { color: var(--faint); }
.search:focus { border-color: var(--amber); outline: none; }

.chips { display: flex; gap: 6px; }
.chip {
  background: transparent;
  border: 1px solid var(--line);
  border-radius: 6px;
  color: var(--dim);
  font-size: 11px;
  padding: 3px 10px;
  transition: color 0.2s var(--ease-out), border-color 0.2s var(--ease-out), background 0.2s var(--ease-out);
}
.chip:hover { color: var(--text); }
.chip.on { color: var(--amber); border-color: rgba(232, 163, 61, 0.55); background: var(--amber-soft); }

.list { flex: 1; overflow-y: auto; }
.hint { padding: 24px 16px; font-size: 12px; color: var(--dim); line-height: 1.7; }

/* ---- 右栏 ---- */
.main { grid-area: main; min-width: 0; min-height: 0; }
.sessions-pane { height: 100%; }
.empty {
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  color: var(--dim);
}
.wordmark-ghost {
  font-family: var(--display);
  font-weight: 700;
  letter-spacing: 0.32em;
  font-size: 15px;
  color: transparent;
  -webkit-text-stroke: 1px var(--faint);
}

/* 视图切换：淡入上移 */
.view-fade-enter-active { transition: opacity 0.28s var(--ease-out), transform 0.28s var(--ease-out); }
.view-fade-leave-active { transition: opacity 0.14s ease-in; }
.view-fade-enter-from { opacity: 0; transform: translateY(8px); }
.view-fade-leave-to { opacity: 0; }
.view-fade-enter-active, .view-fade-leave-active { height: 100%; }
.view-fade-enter-active > *, .view-fade-leave-active > * { height: 100%; }

@media (max-width: 860px) {
  .layout { grid-template-columns: 1fr; grid-template-areas: 'top' 'main'; }
  .sidebar { display: none; }
}

/* 大盘模式：隐藏侧栏，主区通栏 */
.layout.mode-overview {
  grid-template-columns: 1fr;
  grid-template-areas: 'top' 'main';
}
.layout.mode-overview .sidebar { display: none; }
</style>
