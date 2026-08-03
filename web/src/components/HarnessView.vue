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
interface Candidate { project_path: string; corrections: number }

const suggestions = ref<Suggestion[]>([])
const modelAdvice = ref<ModelAdvice[]>([])
const candidates = ref<Candidate[]>([])
const loading = ref(true)
const generatingFor = ref<string | null>(null)
const showDismissed = ref(false)
const feedback = ref('')

const pending = computed(() => suggestions.value.filter((s) => s.status === 'pending'))
const adopted = computed(() => suggestions.value.filter((s) => s.status === 'adopted'))
const dismissed = computed(() => suggestions.value.filter((s) => s.status === 'dismissed'))

// 有待处理建议的项目 + 有信号但还没建议的项目（可以生成）
const pendingProjects = computed(() => [...new Set(pending.value.map((s) => s.project_path))])

async function load() {
  try {
    const d = await fetch('/api/harness/suggestions').then((r) => r.json())
    suggestions.value = d.suggestions
    modelAdvice.value = d.modelAdvice
    candidates.value = d.candidates ?? []
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

      <!-- 模型建议 -->
      <section class="card">
        <h3 class="c-title mono">模型选择建议 · 近 90 天数据</h3>
        <div v-if="!modelAdvice.length" class="hint">当前模型组合没有明显的优化空间</div>
        <div v-for="(a, i) in modelAdvice" :key="i" class="advice">
          <span class="bulb">💡</span>
          <span class="advice-text">{{ a.content }}</span>
        </div>
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

.advice { display: flex; gap: 10px; padding: 10px 4px; border-bottom: 1px solid var(--line); font-size: 13px; }
.advice:last-child { border-bottom: none; }
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

.done-item { display: flex; gap: 10px; padding: 7px 4px; border-bottom: 1px solid var(--line); font-size: 12px; align-items: baseline; }
.done-item:last-child { border-bottom: none; }
.done-item.dim { opacity: 0.5; }
.done-text { flex: 1; color: var(--text); }
.done-path { color: var(--codex); font-size: 10px; }
</style>
