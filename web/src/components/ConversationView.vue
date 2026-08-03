<script setup lang="ts">
import { nextTick, onMounted, ref, watch } from 'vue'
import { api, fmtTokens, type Message, type Review, type Risk, type SessionRow } from '../api'
import MessageItem from './MessageItem.vue'
import ReviewPanel from './ReviewPanel.vue'

const props = defineProps<{ sessionId: string; liveTick?: number; jumpSeq?: number | null }>()

const session = ref<SessionRow | null>(null)
const messages = ref<Message[]>([])
const risks = ref<Risk[]>([])
const reviews = ref<Review[]>([])
const subs = ref<SessionRow[]>([])
const loading = ref(true)
const error = ref('')
const reviewing = ref(false)
const reviewError = ref('')
const persistedTo = ref<string | null>(null)
const showReviewMenu = ref(false)
let reviewPoll: ReturnType<typeof setTimeout> | null = null

async function triggerReview(persist: 'none' | 'instructions' | 'skill' = 'none') {
  showReviewMenu.value = false
  reviewing.value = true
  reviewError.value = ''
  persistedTo.value = null
  const before = new Set(reviews.value.map((r) => r.id))
  try {
    const res = await fetch(`/api/sessions/${encodeURIComponent(props.sessionId)}/review`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ persist }),
    })
    if (!res.ok) throw new Error((await res.json()).error ?? `HTTP ${res.status}`)
    // 轮询等新复盘出现（agent headless 评审要 1-5 分钟）
    const deadline = Date.now() + 5 * 60_000
    const poll = async () => {
      try {
        const latest = await api.reviews(props.sessionId)
        if (latest.some((r) => !before.has(r.id))) {
          reviews.value = latest
          reviewing.value = false
          const st = await fetch(`/api/sessions/${encodeURIComponent(props.sessionId)}/review-status`).then((r) => r.json())
          if (st.persisted) persistedTo.value = st.persisted
          return
        }
        const st = await fetch(`/api/sessions/${encodeURIComponent(props.sessionId)}/review-status`).then((r) => r.json())
        if (st.error) {
          reviewError.value = st.error
          reviewing.value = false
          return
        }
      } catch { /* 网络抖动就继续等 */ }
      if (Date.now() < deadline) reviewPoll = setTimeout(poll, 3000)
      else { reviewError.value = '复盘超时'; reviewing.value = false }
    }
    reviewPoll = setTimeout(poll, 3000)
  } catch (e: any) {
    reviewError.value = e?.message ?? '触发失败'
    reviewing.value = false
  }
}

// 目标指令文件名按 agent 区分
const instructionFile = computed(() => session.value?.agent === 'claude' ? 'CLAUDE.md' : 'AGENTS.md')

// 风险 chips 按规则聚合并计数，同规则只显示一个
import { computed } from 'vue'
const riskGroups = computed(() => {
  const map = new Map<string, { rule: string; severity: string; count: number; snippet: string | null }>()
  for (const r of risks.value) {
    const g = map.get(r.rule)
    if (g) {
      g.count++
      if (r.severity === 'high') g.severity = 'high'
    } else {
      map.set(r.rule, { rule: r.rule, severity: r.severity, count: 1, snippet: r.snippet })
    }
  }
  return [...map.values()]
})
const viewParent = ref(false) // 查看的是 subagent 时，提供回到父会话的入口

async function load() {
  loading.value = true
  error.value = ''
  try {
    const data = await api.messages(props.sessionId)
    session.value = data.session
    messages.value = data.messages
    risks.value = (data as any).risks ?? []
    reviews.value = await api.reviews(props.sessionId).catch(() => [])
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

// 搜索跳转定位：消息加载后滚动到 data-seq 对应的消息并闪烁高亮
// 定位一次即消费：liveTick 增量刷新 messages 时不会把用户拉回旧定位点
const convEl = ref<HTMLElement | null>(null)
let consumedSeq: number | null = null
async function scrollToSeq(seq: number) {
  await nextTick()
  const el = convEl.value?.querySelector(`[data-seq="${seq}"]`) as HTMLElement | null
  if (!el) return
  consumedSeq = seq
  el.scrollIntoView({ block: 'center' })
  el.classList.add('flash')
  setTimeout(() => el.classList.remove('flash'), 2400)
}
watch([messages, () => props.jumpSeq], () => {
  if (props.jumpSeq != null && props.jumpSeq !== consumedSeq && messages.value.length) scrollToSeq(props.jumpSeq)
})
watch(() => props.sessionId, () => { consumedSeq = null })

// 实时推送：当前会话有新消息入库时，只增量刷新消息流，不动头部
watch(() => props.liveTick, async () => {
  if (!props.sessionId) return
  try {
    const data = await api.messages(props.sessionId)
    messages.value = data.messages
    reviews.value = await api.reviews(props.sessionId).catch(() => reviews.value)
  } catch { /* 静默失败，下次事件再试 */ }
})

const emit = defineEmits<{ select: [id: string] }>()
</script>

<template>
  <div class="conv" ref="convEl">
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
        <div class="review-actions">
          <button class="review-btn mono" :disabled="reviewing" @click="showReviewMenu = !showReviewMenu">
            {{ reviewing ? '复盘中…' : '复盘 ▾' }}
          </button>
          <div v-if="showReviewMenu" class="review-menu">
            <button class="menu-item" @click="triggerReview('none')">只复盘</button>
            <button class="menu-item" @click="triggerReview('instructions')">复盘 + 写入 {{ instructionFile }}</button>
            <button class="menu-item" @click="triggerReview('skill')">复盘 + 沉淀为 skill</button>
          </div>
        </div>
        <span v-if="persistedTo" class="persisted">已沉淀 → {{ persistedTo }}</span>
        <span v-else-if="persistedTo === '' &amp;&amp; !reviewing" class="persisted-none">没有可沉淀的教训</span>
        <span v-if="reviewError" class="review-err">{{ reviewError }}</span>
      </div>
      <div v-if="riskGroups.length" class="risks">
        <span
          v-for="g in riskGroups" :key="g.rule"
          class="risk-chip mono"
          :class="g.severity"
          :title="g.snippet ?? ''"
        >{{ g.rule }}<template v-if="g.count > 1"> ×{{ g.count }}</template></span>
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

    <ReviewPanel :reviews="reviews" />

    <div v-if="loading" class="state">加载中…</div>
    <div v-else-if="error" class="state">出错了：{{ error }}</div>
    <div v-else-if="!messages.length" class="state">这个会话还没有消息记录</div>

    <div v-else class="flow">
      <MessageItem v-for="m in messages" :key="m.seq" :message="m" :data-seq="m.seq" />
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
.review-btn {
  margin-left: auto;
  background: transparent;
  border: 1px solid var(--amber);
  border-radius: 4px;
  color: var(--amber);
  font-size: 11px;
  padding: 2px 12px;
}
.review-btn:hover:not(:disabled) { background: rgba(232, 163, 61, 0.12); }
.review-btn:disabled { opacity: 0.55; cursor: wait; }
.review-err { color: var(--danger); font-size: 11px; }
.review-actions { position: relative; margin-left: auto; }
.review-actions .review-btn { margin-left: 0; }
.review-menu {
  position: absolute;
  right: 0;
  top: calc(100% + 4px);
  z-index: 10;
  background: var(--panel-2);
  border: 1px solid var(--line);
  border-radius: 6px;
  padding: 4px;
  display: flex;
  flex-direction: column;
  min-width: 190px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
}
.menu-item {
  background: none;
  border: none;
  color: var(--text);
  font-size: 12px;
  text-align: left;
  padding: 7px 10px;
  border-radius: 4px;
}
.menu-item:hover { background: rgba(232, 163, 61, 0.12); color: var(--amber); }
.persisted { color: var(--codex); font-size: 11px; }
.persisted-none { color: var(--faint); font-size: 11px; }

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

/* 搜索跳转的目标消息闪烁高亮 */
.conv :deep(.msg.flash) {
  animation: flash-bg 2.4s ease-out;
  border-radius: 6px;
}
@keyframes flash-bg {
  0%, 40% { background: rgba(232, 163, 61, 0.18); box-shadow: 0 0 0 1px rgba(232, 163, 61, 0.5); }
  100% { background: transparent; box-shadow: none; }
}
</style>
