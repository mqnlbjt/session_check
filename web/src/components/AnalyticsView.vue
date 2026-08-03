<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { api, fmtTokens } from '../api'

interface HeatCell { messages: number; output_tokens: number }
interface ModelRow { model: string; sessions: number; input_tokens: number; output_tokens: number; cost: number | null; avg_tps: number | null; avg_corrections: number }
interface ProjectRow { project_path: string; sessions: number; messages: number; input_tokens: number; output_tokens: number; cost: number }
interface ProjectDetail { daily: { d: string; cost: number; output_tokens: number }[]; commits: { d: string; n: number }[] }
interface Lessons {
  signalRules: { rule: string; kind: string; n: number }[]
  byProject: { project_path: string; corrections: number; frustrations: number }[]
  findingTypes: { type: string; n: number }[]
  lessons: { type: string; detail: string; evidence?: string; session_id: string; project_path: string | null; session_title: string | null; created_at: string }[]
}

const grid = ref<HeatCell[][]>([])
const models = ref<ModelRow[]>([])
const projects = ref<ProjectRow[]>([])
const lessons = ref<Lessons | null>(null)
const loading = ref(true)
const expanded = ref<string | null>(null)
const detail = ref<ProjectDetail | null>(null)
const detailLoading = ref(false)

const DOW_LABEL = ['日', '一', '二', '三', '四', '五', '六']

onMounted(async () => {
  try {
    const [h, m, p, l] = await Promise.all([
      fetch('/api/analytics/heatmap').then((r) => r.json()),
      fetch('/api/analytics/models').then((r) => r.json()),
      fetch('/api/analytics/projects').then((r) => r.json()),
      fetch('/api/lessons').then((r) => r.json()),
    ])
    grid.value = h.grid
    models.value = m
    projects.value = p
    lessons.value = l
  } finally {
    loading.value = false
  }
})

const heatMaxValue = computed(() => Math.max(1, ...grid.value.flat().map((c) => c.messages)))

function heatOpacity(cell: HeatCell): number {
  return cell.messages === 0 ? 0.08 : 0.15 + 0.85 * (cell.messages / heatMaxValue.value)
}

async function toggleProject(path: string) {
  if (expanded.value === path) { expanded.value = null; return }
  expanded.value = path
  detailLoading.value = true
  detail.value = null
  try {
    detail.value = await fetch(`/api/analytics/project?path=${encodeURIComponent(path)}`).then((r) => r.json())
  } catch { detail.value = null } finally {
    detailLoading.value = false
  }
}

// 并排曲线的通用柱状计算
const CHART_W = 640, CHART_H = 70
function bars(series: { d: string; v: number }[]) {
  const max = Math.max(1, ...series.map((x) => x.v))
  const bw = CHART_W / Math.max(1, series.length)
  return series.map((x, i) => ({
    x: i * bw + 0.5, y: CHART_H - Math.max(1, (x.v / max) * (CHART_H - 12)),
    w: Math.max(1, bw - 1), h: Math.max(1, (x.v / max) * (CHART_H - 12)), ...x,
  }))
}

const FINDING_LABEL: Record<string, string> = {
  rework: '返工', correction: '纠正', misunderstanding: '理解偏差',
  good_practice: '亮点', lesson: '经验', risk: '风险',
}
const RULE_LABEL: Record<string, string> = {
  wrong: '不对/错了', redo: '重来/重新', 'not-what-i-said': '我不是说',
  'stop-change': '别改/回退', 'why-did-you': '你为什么', again: '怎么又',
  'still-broken': '还是不行', 'give-up': '算了',
}

function shortPath(p: string) {
  const parts = p.split('/')
  return parts.length > 2 ? '…/' + parts.slice(-2).join('/') : p
}
function fmtCost(c: number | null | undefined): string {
  if (c == null) return '—'
  return c >= 100 ? `$${c.toFixed(0)}` : `$${c.toFixed(2)}`
}
</script>

<template>
  <div class="analytics">
    <div v-if="loading" class="hint">加载中…</div>
    <template v-else>
      <!-- 热力图 -->
      <section class="card">
        <h3 class="c-title mono">使用热力图 · 时 × 星期 · 近 90 天</h3>
        <div class="heatmap">
          <div class="hm-corner"></div>
          <div v-for="h in 24" :key="h" class="hm-hour mono">{{ h - 1 }}</div>
          <template v-for="(row, dow) in grid" :key="dow">
            <div class="hm-dow mono">{{ DOW_LABEL[dow] }}</div>
            <div
              v-for="(cell, hour) in row" :key="hour"
              class="hm-cell"
              :style="{ opacity: heatOpacity(cell) }"
              :title="`周${DOW_LABEL[dow]} ${hour}:00 · ${cell.messages} 消息 · ${fmtTokens(cell.output_tokens)} tok`"
            ></div>
          </template>
        </div>
      </section>

      <!-- 模型对比 -->
      <section class="card">
        <h3 class="c-title mono">模型对比</h3>
        <table class="tbl">
          <thead>
            <tr class="mono">
              <th>模型</th><th>会话</th><th>成本</th><th>TPS</th><th>平均纠正/会话</th><th>output</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="m in models" :key="m.model">
              <td class="mono">{{ m.model }}</td>
              <td>{{ m.sessions }}</td>
              <td class="cost">{{ fmtCost(m.cost) }}</td>
              <td>{{ m.avg_tps ?? '—' }}</td>
              <td :class="{ warn: m.avg_corrections >= 1 }">{{ m.avg_corrections }}</td>
              <td class="mono">{{ fmtTokens(m.output_tokens) }}</td>
            </tr>
          </tbody>
        </table>
      </section>

      <!-- 项目成本榜 -->
      <section class="card">
        <h3 class="c-title mono">项目成本榜 · 点击展开成本 vs commit</h3>
        <div v-for="p in projects" :key="p.project_path" class="proj">
          <button class="proj-row" @click="toggleProject(p.project_path)">
            <span class="p-path mono" :title="p.project_path">{{ shortPath(p.project_path) }}</span>
            <span class="p-stat">{{ p.sessions }} 会话</span>
            <span class="p-stat mono">{{ fmtTokens(p.output_tokens) }} tok</span>
            <span class="p-cost">{{ fmtCost(p.cost) }}</span>
          </button>
          <div v-if="expanded === p.project_path" class="proj-detail">
            <div v-if="detailLoading" class="hint">加载中…</div>
            <template v-else-if="detail">
              <div class="chart-row">
                <span class="chart-label mono">成本/天</span>
                <svg :viewBox="`0 0 ${CHART_W} ${CHART_H}`" class="chart">
                  <rect v-for="(b, i) in bars(detail.daily.map((x) => ({ d: x.d, v: x.cost })))" :key="i"
                    :x="b.x" :y="b.y" :width="b.w" :height="b.h" class="bar amber">
                    <title>{{ b.d }} · {{ fmtCost(b.v) }}</title>
                  </rect>
                </svg>
              </div>
              <div class="chart-row">
                <span class="chart-label mono">commit/天</span>
                <svg v-if="detail.commits.length" :viewBox="`0 0 ${CHART_W} ${CHART_H}`" class="chart">
                  <rect v-for="(b, i) in bars(detail.commits.map((x) => ({ d: x.d, v: x.n })))" :key="i"
                    :x="b.x" :y="b.y" :width="b.w" :height="b.h" class="bar green">
                    <title>{{ b.d }} · {{ b.v }} commits</title>
                  </rect>
                </svg>
                <span v-else class="nogit">目录不存在或非 git 仓库</span>
              </div>
            </template>
          </div>
        </div>
      </section>
      <!-- 教训聚合 -->
      <section v-if="lessons" class="card">
        <h3 class="c-title mono">教训聚合 · 返工信号 + 复盘经验</h3>
        <div class="lessons-grid">
          <div>
            <h4 class="sub-title mono">信号规则频次</h4>
            <div v-for="r in lessons.signalRules.slice(0, 8)" :key="r.rule" class="rule-row">
              <span class="rule-name">{{ RULE_LABEL[r.rule] ?? r.rule }}</span>
              <div class="rule-bar-wrap">
                <div class="rule-bar" :class="r.kind" :style="{ width: `${(r.n / lessons.signalRules[0].n) * 100}%` }"></div>
              </div>
              <span class="rule-n mono">{{ r.n }}</span>
            </div>
          </div>
          <div>
            <h4 class="sub-title mono">项目纠正分布</h4>
            <div v-for="p in lessons.byProject.slice(0, 8)" :key="p.project_path" class="proj-sig">
              <span class="ps-path mono" :title="p.project_path">{{ shortPath(p.project_path ?? '') }}</span>
              <span class="ps-n correction">↺ {{ p.corrections }}</span>
              <span v-if="p.frustrations" class="ps-n frustration">〜 {{ p.frustrations }}</span>
            </div>
          </div>
        </div>
        <template v-if="lessons.lessons.length">
          <h4 class="sub-title mono">复盘沉淀的经验</h4>
          <div v-for="(l, i) in lessons.lessons" :key="i" class="lesson-item">
            <span class="lesson-type mono" :class="l.type">{{ FINDING_LABEL[l.type] ?? l.type }}</span>
            <span class="lesson-detail">{{ l.detail }}</span>
            <span class="lesson-src mono" :title="l.session_title ?? ''">{{ shortPath(l.project_path ?? '') }}</span>
          </div>
        </template>
        <div v-else class="hint">还没有复盘数据——在会话页点「复盘」积累经验</div>
      </section>
    </template>
  </div>
</template>

<style scoped>
.analytics { height: 100%; overflow-y: auto; padding: 16px 20px 40px; display: flex; flex-direction: column; gap: 14px; }
.hint { padding: 24px; text-align: center; color: var(--dim); font-size: 12px; }

.card {
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 14px 16px;
}
.c-title { font-size: 11px; color: var(--dim); letter-spacing: 0.1em; margin-bottom: 12px; font-weight: 500; }

/* 热力图 */
.heatmap {
  display: grid;
  grid-template-columns: 28px repeat(24, 1fr);
  gap: 2px;
  align-items: center;
}
.hm-corner { width: 28px; }
.hm-hour { font-size: 8px; color: var(--faint); text-align: center; }
.hm-dow { font-size: 10px; color: var(--dim); text-align: center; }
.hm-cell {
  aspect-ratio: 1;
  min-height: 12px;
  background: var(--amber);
  border-radius: 2px;
}

/* 表格 */
.tbl { width: 100%; border-collapse: collapse; font-size: 12px; }
.tbl th {
  text-align: left; font-size: 10px; color: var(--faint); font-weight: 500;
  padding: 4px 10px 8px 0; border-bottom: 1px solid var(--line);
}
.tbl td { padding: 7px 10px 7px 0; border-bottom: 1px solid var(--line); color: var(--text); }
.tbl tr:last-child td { border-bottom: none; }
.tbl .cost { color: var(--amber); }
.tbl .warn { color: var(--danger); }

/* 项目榜 */
.proj { border-bottom: 1px solid var(--line); }
.proj:last-child { border-bottom: none; }
.proj-row {
  display: flex; align-items: center; gap: 14px;
  width: 100%; background: none; border: none; padding: 9px 4px;
  color: var(--text); font-size: 12px; cursor: pointer; text-align: left;
}
.proj-row:hover { background: rgba(232, 163, 61, 0.05); }
.p-path { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.p-stat { color: var(--dim); font-size: 11px; }
.p-cost { color: var(--amber); font-size: 12px; min-width: 60px; text-align: right; }
.proj-detail { padding: 6px 4px 12px; }
.chart-row { display: flex; align-items: center; gap: 10px; margin-top: 8px; }
.chart-label { font-size: 10px; color: var(--faint); width: 64px; flex-shrink: 0; }
.chart { flex: 1; height: 70px; }
.bar { fill: var(--dim); opacity: 0.7; }
.bar.amber { fill: var(--amber); }
.bar.green { fill: var(--codex); }
.nogit { font-size: 11px; color: var(--faint); }

/* 教训聚合 */
.lessons-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; margin-bottom: 14px; }
.sub-title { font-size: 10px; color: var(--faint); letter-spacing: 0.08em; margin: 8px 0 10px; font-weight: 500; }
.rule-row { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; font-size: 11px; }
.rule-name { width: 76px; flex-shrink: 0; color: var(--dim); }
.rule-bar-wrap { flex: 1; height: 10px; background: var(--ink); border-radius: 3px; overflow: hidden; }
.rule-bar { height: 100%; border-radius: 3px; }
.rule-bar.correction { background: var(--amber); }
.rule-bar.frustration { background: var(--faint); }
.rule-n { width: 28px; text-align: right; color: var(--dim); font-size: 10px; }
.proj-sig { display: flex; align-items: center; gap: 10px; padding: 4px 0; font-size: 11px; border-bottom: 1px solid var(--line); }
.proj-sig:last-child { border-bottom: none; }
.ps-path { flex: 1; color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ps-n.correction { color: var(--amber); }
.ps-n.frustration { color: var(--faint); }
.lesson-item { display: flex; align-items: baseline; gap: 10px; padding: 6px 0; border-bottom: 1px solid var(--line); font-size: 12px; }
.lesson-item:last-child { border-bottom: none; }
.lesson-type { flex-shrink: 0; font-size: 10px; padding: 1px 6px; border-radius: 3px; border: 1px solid var(--line); color: var(--dim); }
.lesson-type.lesson { color: var(--codex); border-color: rgba(91, 157, 214, 0.4); }
.lesson-type.good_practice { color: var(--amber); border-color: rgba(232, 163, 61, 0.4); }
.lesson-detail { flex: 1; color: var(--text); }
.lesson-src { color: var(--faint); font-size: 10px; }
@media (max-width: 900px) { .lessons-grid { grid-template-columns: 1fr; } }
</style>
