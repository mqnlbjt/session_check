<script setup lang="ts">
import { ref, watch } from 'vue'
import { api, fmtTime, type SearchRow } from '../api'
import { Search, ArrowRight } from 'lucide-vue-next'

const emit = defineEmits<{ jump: [sessionId: string, seq: number] }>()

const q = ref('')
const agent = ref('')
const project = ref('')
const rows = ref<SearchRow[]>([])
const total = ref(0)
const searched = ref(false)
const loading = ref(false)
const loadingMore = ref(false)
const errorMsg = ref('')

const AGENTS = [
  { value: '', label: '全部' },
  { value: 'pi', label: 'pi' },
  { value: 'claude', label: 'claude' },
  { value: 'codex', label: 'codex' },
]

async function run(reset = true) {
  const query = q.value.trim()
  if (!query) { rows.value = []; total.value = 0; searched.value = false; errorMsg.value = ''; return }
  if (reset) { loading.value = true; rows.value = [] } else loadingMore.value = true
  errorMsg.value = ''
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
  } catch (e: any) {
    errorMsg.value = `搜索失败：${e?.message ?? '未知错误'}`
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
    <header class="view-head rise">
      <h2 class="view-title">搜索</h2>
      <span class="view-sub mono">Full-text · 消息正文与命令秒级定位</span>
    </header>
    <div class="bar rise rise-1">
      <div class="q-wrap">
        <Search class="lucide q-icon" />
        <input v-model="q" class="q" type="search" placeholder="全文搜索消息内容（支持中文，≥3 字符走索引）…" aria-label="全文搜索" />
      </div>
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
    <div v-else-if="errorMsg" class="hint err">{{ errorMsg }}</div>
    <div v-else-if="!searched" class="hint">输入关键词搜索全部会话的消息正文和工具命令</div>
    <div v-else-if="!rows.length" class="hint">没有匹配的消息</div>

    <template v-else>
      <div class="count mono">{{ total.toLocaleString() }} 条匹配</div>
      <button
        v-for="(r, ri) in rows" :key="r.message_id"
        class="hit rise"
        :style="{ animationDelay: `${Math.min(ri, 10) * 0.04}s` }"
        @click="emit('jump', r.session_id, r.seq)"
      >
        <div class="hit-head mono">
          <span class="badge" :class="r.agent">{{ r.agent }}</span>
          <span class="role">{{ ROLE_LABEL[r.role] ?? r.role }}</span>
          <span class="time">{{ fmtTime(r.ts) }}</span>
          <span class="proj">{{ r.project_path }}</span>
          <ArrowRight class="lucide go" />
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
.searchview { height: 100%; overflow-y: auto; padding: 26px 28px 48px; max-width: 1080px; margin: 0 auto; width: 100%; }

.bar { margin-bottom: 16px; }
.q-wrap { position: relative; margin-bottom: 9px; }
.q-icon {
  position: absolute;
  left: 12px;
  top: 50%;
  transform: translateY(-50%);
  color: var(--faint);
  pointer-events: none;
}
.q {
  width: 100%;
  background: var(--ink);
  border: 1px solid var(--line);
  border-radius: 8px;
  color: var(--text);
  font-size: 14px;
  padding: 11px 12px 11px 36px;
}
.q::placeholder, .proj::placeholder { color: var(--faint); }
.q:focus, .proj:focus { border-color: var(--amber); outline: none; box-shadow: 0 0 0 3px rgba(232, 163, 61, 0.12); }

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
.hint.err { color: var(--danger); }

.hit {
  display: block;
  width: 100%;
  text-align: left;
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 12px 16px;
  margin-bottom: 8px;
  cursor: pointer;
  transition: border-color 0.2s var(--ease-out), transform 0.2s var(--spring), box-shadow 0.2s var(--ease-out);
}
.hit:hover {
  border-color: rgba(232, 163, 61, 0.5);
  transform: translateY(-1px);
  box-shadow: 0 6px 20px rgba(5, 7, 10, 0.4);
}
.hit:hover .go { opacity: 1; transform: translateX(0); color: var(--amber); }
.go { opacity: 0; transform: translateX(-4px); transition: opacity 0.2s, transform 0.2s var(--spring), color 0.2s; margin-left: 8px; }

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
