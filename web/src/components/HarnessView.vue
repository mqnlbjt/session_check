<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'

interface Suggestion {
  id: number
  project_path: string
  kind: string
  content: string
  evidence: string | null
  status: 'pending' | 'adopted' | 'dismissed'
  created_at: string
  adopted_to: string | null
}
interface ModelAdvice { content: string; evidence: string }
interface AdviceMetrics {
  model: string; sessions: number; cost: number; avg_corrections: number
  fail_rate: number; avg_latency_s: number | null; avg_tps: number | null
  cache_hit_pct: number; active_hours: number; commits: number; code_lines: number
}
interface AdviceEvidence { window_days: number; from: AdviceMetrics; to: AdviceMetrics; saving_pct: number }

function parseEvidence(e: string): AdviceEvidence | null {
  try { const d = JSON.parse(e); return d.from && d.to ? d : null } catch { return null }
}

const METRIC_ROWS: { key: keyof AdviceMetrics; label: string; fmt: (v: any) => string; betterLow?: boolean }[] = [
  { key: 'cost', label: '成本', fmt: (v) => `$${Number(v).toFixed(1)}`, betterLow: true },
  { key: 'sessions', label: '会话数', fmt: String },
  { key: 'code_lines', label: '代码行', fmt: (v) => v > 0 ? Number(v).toLocaleString() : '—' },
  { key: 'active_hours', label: '活跃时长', fmt: (v) => v > 0 ? `${v}h` : '—' },
  { key: 'avg_corrections', label: '纠正/会话', fmt: String, betterLow: true },
  { key: 'fail_rate', label: '失败率', fmt: (v) => `${v}%`, betterLow: true },
  { key: 'avg_latency_s', label: '响应时长', fmt: (v) => v != null ? `${v}s` : '—', betterLow: true },
  { key: 'avg_tps', label: 'TPS', fmt: (v) => v ?? '—' },
  { key: 'cache_hit_pct', label: '缓存命中', fmt: (v) => `${v}%` },
]
interface Candidate { project_path: string; corrections: number }
interface PendingWrite {
  id: number
  session_id: string | null
  kind: 'instructions' | 'skill'
  target_path: string
  content: string
  status: 'pending' | 'confirmed' | 'discarded'
  created_at: string
  confirmed_at: string | null
}

const suggestions = ref<Suggestion[]>([])
const pendingWrites = ref<PendingWrite[]>([])
const modelAdvice = ref<ModelAdvice[]>([])
const taskAdvice = ref<{ task: string; content: string; evidence: string }[]>([])
const taskMatrix = ref<{ task: string; model: string; sessions: number; cost: number; cost_per_session: number; avg_corrections: number }[]>([])
const candidates = ref<Candidate[]>([])
const loading = ref(true)
const generatingFor = ref<string | null>(null)
const showDismissed = ref(false)
const feedback = ref('')

const pending = computed(() => suggestions.value.filter((s) => s.status === 'pending'))
const pendingWritesActive = computed(() => pendingWrites.value.filter((w) => w.status === 'pending'))
const adopted = computed(() => suggestions.value.filter((s) => s.status === 'adopted'))
const dismissed = computed(() => suggestions.value.filter((s) => s.status === 'dismissed'))

// 有待处理建议的项目 + 有信号但还没建议的项目（可以生成）
const pendingProjects = computed(() => [...new Set(pending.value.map((s) => s.project_path))])

async function load() {
  try {
    const d = await fetch('/api/harness/suggestions').then((r) => r.json())
    suggestions.value = d.suggestions
    modelAdvice.value = d.modelAdvice
    taskAdvice.value = d.taskAdvice ?? []
    candidates.value = d.candidates ?? []
    taskMatrix.value = await fetch('/api/analytics/task-models?window=30').then((r) => r.json()).catch(() => [])
    pendingWrites.value = await fetch('/api/pending-writes').then((r) => r.json()).catch(() => [])
  } finally {
    loading.value = false
  }
}
onMounted(load)

// 生成后轮询等新建议（LLM 要 1-3 分钟）；句柄用 Set 防多链并发生成时泄漏
const polls = new Set<ReturnType<typeof setTimeout>>()
async function generate(projectPath: string) {
  generatingFor.value = projectPath
  feedback.value = ''
  const before = new Set(suggestions.value.map((s) => s.id))
  try {
    const res = await fetch('/api/harness/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project_path: projectPath }),
    })
    if (!res.ok) throw new Error((await res.json()).error ?? `HTTP ${res.status}`)
    const deadline = Date.now() + 4 * 60_000
    const tick = async () => {
      await load()
      const hasNew = suggestions.value.some((s) => !before.has(s.id) && s.project_path === projectPath)
      if (hasNew) {
        generatingFor.value = null
        feedback.value = '新建议已生成'
        return
      }
      if (Date.now() < deadline) {
        const t = setTimeout(() => { polls.delete(t); tick() }, 4000)
        polls.add(t)
      } else { generatingFor.value = null; feedback.value = '生成超时或无新建议（可能与已有建议重复）' }
    }
    const t0 = setTimeout(() => { polls.delete(t0); tick() }, 4000)
    polls.add(t0)
  } catch (e: any) {
    generatingFor.value = null
    feedback.value = `生成失败：${e?.message ?? '未知错误'}`
  }
}
onUnmounted(() => { for (const t of polls) clearTimeout(t); polls.clear() })

async function adopt(s: Suggestion) {
  const res = await fetch(`/api/harness/suggestions/${s.id}/adopt`, { method: 'POST' })
  if (res.ok) {
    const body = await res.json()
    feedback.value = `已写入 ${body.adopted_to}`
    await load()
  } else {
    feedback.value = '采纳失败'
  }
}

async function dismiss(s: Suggestion) {
  await fetch(`/api/harness/suggestions/${s.id}/dismiss`, { method: 'POST' })
  feedback.value = '已忽略'
  await load()
}

function evidenceText(e: string | null): string {
  if (!e) return ''
  try {
    const arr = JSON.parse(e) as { rule: string; n: number }[]
    return arr.map((x) => `${x.rule}×${x.n}`).join(' · ')
  } catch { return '' }
}

async function confirmWrite(w: PendingWrite) {
  const res = await fetch(`/api/pending-writes/${w.id}/confirm`, { method: 'POST' })
  if (res.ok) {
    const body = await res.json()
    feedback.value = `已写入 ${body.written_to}`
  } else {
    feedback.value = `写入失败：${(await res.json()).error ?? res.status}`
  }
  await load()
}

async function discardWrite(w: PendingWrite) {
  await fetch(`/api/pending-writes/${w.id}/discard`, { method: 'POST' })
  feedback.value = '已放弃该写入'
  await load()
}

function shortPath(p: string) {
  const parts = p.split('/')
  return parts.length > 2 ? '…/' + parts.slice(-2).join('/') : p
}
</script>

<template>
  <div class="harness">
    <div v-if="loading" class="hint">加载中…</div>
    <template v-else>
      <div v-if="feedback" class="feedback mono">{{ feedback }}</div>

      <!-- 待确认的写入（复盘沉淀两阶段：确认才落盘） -->
      <section v-if="pendingWritesActive.length" class="card pending-writes">
        <h3 class="c-title mono">待确认的写入 · {{ pendingWritesActive.length }}</h3>
        <div v-for="w in pendingWritesActive" :key="w.id" class="write-item">
          <div class="w-head mono">
            <span class="w-kind" :class="w.kind">{{ w.kind === 'skill' ? 'SKILL' : 'AGENTS.md' }}</span>
            <span class="w-path" :title="w.target_path">{{ w.target_path }}</span>
          </div>
          <pre class="w-content">{{ w.content }}</pre>
          <div class="w-actions">
            <button class="btn adopt" @click="confirmWrite(w)">确认写入</button>
            <button class="btn dismiss" @click="discardWrite(w)">放弃</button>
          </div>
        </div>
      </section>

      <!-- 模型建议 -->
      <section class="card">
        <h3 class="c-title mono">模型选择建议 · 近 30 天数据</h3>
        <div v-if="!modelAdvice.length" class="hint">当前模型组合没有明显的优化空间</div>
        <div v-for="(a, i) in modelAdvice" :key="i" class="advice-block">
          <div class="advice">
            <span class="bulb">💡</span>
            <span class="advice-text">{{ a.content }}</span>
          </div>
          <table v-if="parseEvidence(a.evidence)" class="cmp">
            <thead>
              <tr class="mono">
                <th></th>
                <th>{{ parseEvidence(a.evidence)!.from.model }}</th>
                <th class="to">{{ parseEvidence(a.evidence)!.to.model }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="row in METRIC_ROWS" :key="row.key">
                <td class="cmp-label">{{ row.label }}</td>
                <td :class="{ worse: row.betterLow && parseEvidence(a.evidence)!.from[row.key] > parseEvidence(a.evidence)!.to[row.key] }">
                  {{ row.fmt(parseEvidence(a.evidence)!.from[row.key]) }}
                </td>
                <td class="to" :class="{ better: row.betterLow && parseEvidence(a.evidence)!.to[row.key] < parseEvidence(a.evidence)!.from[row.key] }">
                  {{ row.fmt(parseEvidence(a.evidence)!.to[row.key]) }}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <!-- 任务×模型推荐 -->
      <section class="card">
        <h3 class="c-title mono">任务 × 模型 · 什么任务用什么模型 · 近 30 天</h3>
        <div v-for="(a, i) in taskAdvice" :key="i" class="advice">
          <span class="bulb">🎯</span>
          <span class="advice-text">{{ a.content }}</span>
        </div>
        <div v-if="!taskAdvice.length" class="hint">各任务下的模型选择当前都比较合理</div>
        <details class="matrix-wrap">
          <summary class="mono">完整矩阵（{{ taskMatrix.length }} 行）</summary>
          <table class="tbl">
            <thead>
              <tr class="mono"><th>任务</th><th>模型</th><th>会话</th><th>成本/会话</th><th>总成本</th><th>纠正/会话</th></tr>
            </thead>
            <tbody>
              <tr v-for="(r, i) in taskMatrix" :key="i">
                <td>{{ r.task }}</td>
                <td class="mono">{{ r.model }}</td>
                <td>{{ r.sessions }}</td>
                <td>${{ r.cost_per_session }}</td>
                <td>${{ r.cost }}</td>
                <td :class="{ warn: r.avg_corrections >= 1 }">{{ r.avg_corrections }}</td>
              </tr>
            </tbody>
          </table>
        </details>
      </section>

      <!-- 防呆规则建议 -->
      <section class="card">
        <h3 class="c-title mono">防呆规则 · 由纠正信号驱动</h3>

        <!-- 生成入口：有纠正信号的项目（C1 修复：不依赖已有建议） -->
        <div class="gen-panel">
          <span class="gen-label mono">生成建议：</span>
          <button
            v-for="cand in candidates" :key="cand.project_path"
            class="btn gen mono"
            :disabled="generatingFor === cand.project_path"
            :title="cand.project_path"
            @click="generate(cand.project_path)"
          >{{ generatingFor === cand.project_path ? '生成中…' : `${shortPath(cand.project_path)} ↺${cand.corrections}` }}</button>
        </div>

        <div v-if="!pending.length" class="hint">暂无待处理建议。点上方项目按钮，用该项目的纠正信号生成防呆规则。</div>

        <div v-for="proj in pendingProjects" :key="proj" class="proj-group">
          <div class="proj-head mono">{{ shortPath(proj) }}</div>
          <div v-for="s in pending.filter((x) => x.project_path === proj)" :key="s.id" class="suggestion">
            <div class="s-content">{{ s.content }}</div>
            <div class="s-meta mono">
              <span class="s-evidence">依据：{{ evidenceText(s.evidence) }}</span>
              <button class="btn adopt" @click="adopt(s)">采纳 → AGENTS.md</button>
              <button class="btn dismiss" @click="dismiss(s)">忽略</button>
            </div>
          </div>
        </div>

        <!-- 底部不再单独放重新生成入口（已并入顶部生成面板） -->
      </section>

      <!-- 已采纳 -->
      <section v-if="adopted.length" class="card">
        <h3 class="c-title mono">已采纳 · {{ adopted.length }}</h3>
        <div v-for="s in adopted" :key="s.id" class="done-item">
          <span class="done-text">{{ s.content }}</span>
          <span class="done-path mono">→ {{ s.adopted_to }}</span>
        </div>
      </section>

      <!-- 已忽略（折叠） -->
      <section v-if="dismissed.length" class="card">
        <button class="c-title mono toggle" @click="showDismissed = !showDismissed">
          已忽略 · {{ dismissed.length }} {{ showDismissed ? '▾' : '▸' }}
        </button>
        <template v-if="showDismissed">
          <div v-for="s in dismissed" :key="s.id" class="done-item dim">
            <span class="done-text">{{ s.content }}</span>
          </div>
        </template>
      </section>
    </template>
  </div>
</template>

<style scoped>
.harness { height: 100%; overflow-y: auto; padding: 16px 20px 40px; display: flex; flex-direction: column; gap: 14px; }
.hint { padding: 16px; text-align: center; color: var(--dim); font-size: 12px; }
.feedback {
  padding: 8px 14px; font-size: 11px; color: var(--amber);
  background: rgba(232, 163, 61, 0.08); border: 1px solid rgba(232, 163, 61, 0.3); border-radius: 6px;
}

.card { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 14px 16px; }
.c-title { font-size: 11px; color: var(--dim); letter-spacing: 0.1em; margin-bottom: 12px; font-weight: 500; }
.toggle { background: none; border: none; cursor: pointer; padding: 0; }
.toggle:hover { color: var(--amber); }

.advice { display: flex; gap: 10px; padding: 10px 4px 6px; font-size: 13px; }
.advice-block { border-bottom: 1px solid var(--line); padding-bottom: 10px; margin-bottom: 4px; }
.advice-block:last-child { border-bottom: none; }

/* 建议对比表 */
.cmp { width: 100%; border-collapse: collapse; font-size: 11px; margin: 4px 0 6px 26px; max-width: 560px; }
.cmp th { text-align: left; font-size: 10px; color: var(--faint); font-weight: 500; padding: 3px 10px 5px 0; border-bottom: 1px solid var(--line); }
.cmp th.to { color: var(--codex); }
.cmp td { padding: 4px 10px 4px 0; border-bottom: 1px solid var(--line); color: var(--text); }
.cmp tr:last-child td { border-bottom: none; }
.cmp-label { color: var(--dim) !important; }
.cmp td.to { color: var(--codex); }
.cmp td.better { font-weight: 600; }
.cmp td.worse { color: var(--danger); }
.bulb { flex-shrink: 0; }
.advice-text { color: var(--text); line-height: 1.6; }

.proj-group { margin-bottom: 14px; }
.proj-head { font-size: 11px; color: var(--faint); margin-bottom: 8px; }
.suggestion {
  background: var(--ink); border: 1px solid var(--line); border-radius: 6px;
  padding: 10px 12px; margin-bottom: 8px;
}
.s-content { font-size: 13px; color: var(--text); line-height: 1.6; margin-bottom: 8px; }
.s-meta { display: flex; align-items: center; gap: 8px; font-size: 10px; }
.s-evidence { flex: 1; color: var(--faint); }
.btn {
  border: 1px solid var(--line); border-radius: 4px; background: transparent;
  color: var(--dim); font-size: 11px; padding: 3px 10px; cursor: pointer;
}
.btn:hover { color: var(--text); }
.btn.adopt { color: var(--amber); border-color: rgba(232, 163, 61, 0.4); }
.btn.adopt:hover { background: rgba(232, 163, 61, 0.12); }
.btn.gen { margin-right: 8px; }
.btn:disabled { opacity: 0.5; cursor: wait; }
.gen-panel { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; margin-bottom: 12px; }
.gen-label { font-size: 10px; color: var(--faint); }

/* 待确认写入 */
.pending-writes { border-color: rgba(232, 163, 61, 0.4); }
.write-item { background: var(--ink); border: 1px solid var(--line); border-radius: 6px; padding: 10px 12px; margin-bottom: 8px; }
.w-head { display: flex; gap: 10px; align-items: center; margin-bottom: 8px; font-size: 11px; }
.w-kind { flex-shrink: 0; font-size: 10px; padding: 1px 6px; border-radius: 3px; border: 1px solid rgba(232, 163, 61, 0.4); color: var(--amber); }
.w-kind.skill { border-color: rgba(91, 157, 214, 0.4); color: var(--codex); }
.w-path { color: var(--dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.w-content {
  background: var(--panel); border: 1px solid var(--line); border-radius: 4px;
  padding: 8px 10px; font-size: 11px; color: var(--text); line-height: 1.6;
  white-space: pre-wrap; word-break: break-all; max-height: 200px; overflow-y: auto; margin: 0 0 8px;
}
.w-actions { display: flex; gap: 8px; }

/* 任务×模型矩阵 */
.matrix-wrap { margin-top: 12px; }
.matrix-wrap summary { font-size: 11px; color: var(--dim); cursor: pointer; }
.matrix-wrap summary:hover { color: var(--amber); }
.tbl { width: 100%; border-collapse: collapse; font-size: 12px; margin-top: 10px; }
.tbl th { text-align: left; font-size: 10px; color: var(--faint); font-weight: 500; padding: 4px 10px 8px 0; border-bottom: 1px solid var(--line); }
.tbl td { padding: 6px 10px 6px 0; border-bottom: 1px solid var(--line); color: var(--text); }
.tbl tr:last-child td { border-bottom: none; }
.tbl .warn { color: var(--danger); }

.done-item { display: flex; gap: 10px; padding: 7px 4px; border-bottom: 1px solid var(--line); font-size: 12px; align-items: baseline; }
.done-item:last-child { border-bottom: none; }
.done-item.dim { opacity: 0.5; }
.done-text { flex: 1; color: var(--text); }
.done-path { color: var(--codex); font-size: 10px; }
</style>
