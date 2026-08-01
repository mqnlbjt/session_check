<script setup lang="ts">
import { ref, watch } from 'vue'
import { api, fmtTime, type SearchRow } from '../api'

const emit = defineEmits<{ jump: [sessionId: string, seq: number] }>()

const q = ref('')
const agent = ref('')
const project = ref('')
const rows = ref<SearchRow[]>([])
const total = ref(0)
const searched = ref(false)
const loading = ref(false)
const loadingMore = ref(false)

const AGENTS = [
  { value: '', label: '全部' },
  { value: 'pi', label: 'pi' },
  { value: 'claude', label: 'claude' },
  { value: 'codex', label: 'codex' },
]

async function run(reset = true) {
  const query = q.value.trim()
  if (!query) { rows.value = []; total.value = 0; searched.value = false; return }
  if (reset) { loading.value = true; rows.value = [] } else loadingMore.value = true
  try {
    const data = await api.search({
      q: query,
      agent: agent.value || undefined,
      project: project.value.trim() || undefined,
      offset: reset ? 0 : rows.value.length,
    })
    total.value = data.total
    rows.value = reset ? data.rows : [...rows.value, ...data.rows]
    searched.value = true
  } finally {
    loading.value = false
    loadingMore.value = false
  }
}

// 防抖搜索
let timer: ReturnType<typeof setTimeout> | null = null
watch([q, agent, project], () => {
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => run(true), 300)
})

function onScroll(e: Event) {
  const el = e.target as HTMLElement
  if (el.scrollTop + el.clientHeight >= el.scrollHeight - 200 && !loadingMore.value && rows.value.length < total.value) {
    run(false)
  }
}

// snippet 是后端拼的含 <mark> 的文本：先全量转义防 XSS，再恢复 mark 标签
function renderSnippet(s: string): string {
  const esc = s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  return esc.replaceAll('&lt;mark&gt;', '<mark>').replaceAll('&lt;/mark&gt;', '</mark>')
}

const ROLE_LABEL: Record<string, string> = { user: '用户', assistant: '助手', tool: '工具', system: '系统' }
</script>

<template>
  <div class="searchview" @scroll="onScroll">
    <div class="bar">
      <input v-model="q" class="q" type="search" placeholder="全文搜索消息内容（支持中文，≥3 字符走索引）…" aria-label="全文搜索" />
      <div class="filters">
        <div class="chips" role="tablist" aria-label="按 agent 筛选">
          <button
            v-for="a in AGENTS" :key="a.value"
            class="chip mono" :class="{ on: agent === a.value }"
            role="tab" :aria-selected="agent === a.value"
            @click="agent = a.value"
          >{{ a.label }}</button>
        </div>
        <input v-model="project" class="proj mono" type="search" placeholder="项目路径过滤…" aria-label="项目过滤" />
      </div>
    </div>

    <div v-if="loading" class="hint">搜索中…</div>
    <div v-else-if="!searched" class="hint">输入关键词搜索全部会话的消息正文和工具命令</div>
    <div v-else-if="!rows.length" class="hint">没有匹配的消息</div>

    <template v-else>
      <div class="count mono">{{ total.toLocaleString() }} 条匹配</div>
      <button
        v-for="r in rows" :key="r.message_id"
        class="hit"
        @click="emit('jump', r.session_id, r.seq)"
      >
        <div class="hit-head mono">
          <span class="badge" :class="r.agent">{{ r.agent }}</span>
          <span class="role">{{ ROLE_LABEL[r.role] ?? r.role }}</span>
          <span class="time">{{ fmtTime(r.ts) }}</span>
          <span class="proj">{{ r.project_path }}</span>
        </div>
        <!-- eslint-disable-next-line vue/no-v-html -->
        <div class="snip" v-html="renderSnippet(r.snippet)"></div>
        <div class="hit-title">{{ r.session_title ?? '(空会话)' }}</div>
      </button>
      <div v-if="loadingMore" class="hint">加载更多…</div>
    </template>
  </div>
</template>

<style scoped>
.searchview { height: 100%; overflow-y: auto; padding: 16px 20px 40px; }

.bar { margin-bottom: 14px; }
.q {
  width: 100%;
  background: var(--ink);
  border: 1px solid var(--line);
  border-radius: 5px;
  color: var(--text);
  font-size: 14px;
  padding: 9px 12px;
  margin-bottom: 9px;
}
.q::placeholder, .proj::placeholder { color: var(--faint); }
.q:focus, .proj:focus { border-color: var(--amber); outline: none; }

.filters { display: flex; gap: 10px; align-items: center; }
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
.proj {
  flex: 1;
  background: var(--ink);
  border: 1px solid var(--line);
  border-radius: 5px;
  color: var(--text);
  font-size: 12px;
  padding: 5px 10px;
}

.count { font-size: 11px; color: var(--faint); margin-bottom: 10px; }
.hint { padding: 40px 0; text-align: center; font-size: 12px; color: var(--dim); }

.hit {
  display: block;
  width: 100%;
  text-align: left;
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 6px;
  padding: 10px 14px;
  margin-bottom: 8px;
  cursor: pointer;
}
.hit:hover { border-color: var(--amber); }

.hit-head { display: flex; gap: 10px; align-items: center; font-size: 10px; color: var(--faint); margin-bottom: 6px; }
.badge { text-transform: uppercase; letter-spacing: 0.08em; }
.badge.pi { color: var(--pi); }
.badge.claude { color: var(--claude); }
.badge.codex { color: var(--codex); }
.role { color: var(--dim); }
.proj { margin-left: auto; font-size: 10px; color: var(--faint); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 40%; }

.snip { font-size: 13px; line-height: 1.6; color: var(--text); word-break: break-all; }
.snip :deep(mark) { background: rgba(232, 163, 61, 0.25); color: var(--amber); border-radius: 2px; padding: 0 1px; }

.hit-title { margin-top: 6px; font-size: 11px; color: var(--dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style>
