<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { api, fmtTokens } from '../api'

interface Overview {
  today: { sessions: number; messages: number; input_tokens: number; output_tokens: number }
  daily: { d: string; sessions: number; messages: number; output_tokens: number; input_tokens: number }[]
  models: { model: string; sessions: number; output_tokens: number; avg_tps: number | null }[]
  projects: { project_path: string; sessions: number; messages: number; output_tokens: number }[]
  agents: { agent: string; sessions: number; messages: number; input_tokens: number; output_tokens: number; avg_tps: number | null }[]
}

const data = ref<Overview | null>(null)
const loading = ref(true)

async function load() {
  loading.value = true
  try {
    data.value = await fetch('/api/overview').then((r) => r.json())
  } finally {
    loading.value = false
  }
}
onMounted(load)
defineExpose({ reload: load })

// ---- 趋势图：把 daily 补齐成连续 30 天 ----
function fillDays(daily: Overview['daily'], key: 'sessions' | 'output_tokens') {
  const map = new Map(daily.map((r) => [r.d, r[key]]))
  const days: { d: string; v: number }[] = []
  for (let i = 29; i >= 0; i--) {
    const dt = new Date(Date.now() - i * 86400000)
    const key2 = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`
    days.push({ d: key2, v: map.get(key2) ?? 0 })
  }
  return days
}

const CHART_W = 460, CHART_H = 90, PAD = 2
function chartBars(days: { d: string; v: number }[]) {
  const max = Math.max(1, ...days.map((x) => x.v))
  const bw = CHART_W / days.length
  return days.map((x, i) => {
    const h = x.v === 0 ? 1 : Math.max(2, (x.v / max) * (CHART_H - 14))
    return { x: i * bw + PAD / 2, y: CHART_H - h, w: bw - PAD, h, ...x }
  })
}

function shortPath(p: string) {
  const parts = p.split('/')
  return parts.length > 2 ? '…/' + parts.slice(-2).join('/') : p
}

function maxOf(nums: (number | null)[]) {
  return Math.max(1, ...nums.map((n) => n ?? 0))
}
</script>

<template>
  <div class="overview">
    <div v-if="loading && !data" class="state">汇总中…</div>

    <template v-else-if="data">
      <!-- KPI 行 -->
      <section class="kpis">
        <div class="kpi">
          <span class="k-label mono">今日会话</span>
          <span class="k-value">{{ data.today.sessions }}</span>
        </div>
        <div class="kpi">
          <span class="k-label mono">今日消息</span>
          <span class="k-value">{{ data.today.messages.toLocaleString() }}</span>
        </div>
        <div class="kpi">
          <span class="k-label mono">今日 OUTPUT</span>
          <span class="k-value">{{ fmtTokens(data.today.output_tokens) }}</span>
        </div>
        <div class="kpi" v-for="a in data.agents" :key="a.agent">
          <span class="k-label mono" :class="a.agent">{{ a.agent }} 均速</span>
          <span class="k-value">{{ a.avg_tps ?? '—' }}<span class="k-unit"> tok/s</span></span>
        </div>
      </section>

      <!-- 趋势 -->
      <section class="row">
        <div class="card">
          <h3 class="c-title mono">会话数 / 天 · 近 30 天</h3>
          <svg :viewBox="`0 0 ${CHART_W} ${CHART_H}`" class="chart">
            <rect v-for="(b, i) in chartBars(fillDays(data.daily, 'sessions'))" :key="i"
              :x="b.x" :y="b.y" :width="b.w" :height="b.h"
              :class="['bar', { zero: b.v === 0 }]">
              <title>{{ b.d }} · {{ b.v }} 会话</title>
            </rect>
          </svg>
        </div>
        <div class="card">
          <h3 class="c-title mono">OUTPUT TOKENS / 天 · 近 30 天</h3>
          <svg :viewBox="`0 0 ${CHART_W} ${CHART_H}`" class="chart">
            <rect v-for="(b, i) in chartBars(fillDays(data.daily, 'output_tokens'))" :key="i"
              :x="b.x" :y="b.y" :width="b.w" :height="b.h"
              :class="['bar amber', { zero: b.v === 0 }]">
              <title>{{ b.d }} · {{ fmtTokens(b.v) }}</title>
            </rect>
          </svg>
        </div>
      </section>

      <!-- 排行 -->
      <section class="row">
        <div class="card">
          <h3 class="c-title mono">模型排行 · 按 OUTPUT TOKENS</h3>
          <table>
            <thead>
              <tr><th>模型</th><th class="num">会话</th><th class="num">output</th><th class="num">均速</th></tr>
            </thead>
            <tbody>
              <tr v-for="m in data.models" :key="m.model">
                <td class="mono name">{{ m.model }}</td>
                <td class="num mono">{{ m.sessions }}</td>
                <td class="num mono">{{ fmtTokens(m.output_tokens) }}</td>
                <td class="num mono tps-cell">
                  <span v-if="m.avg_tps" class="tps-bar" :style="{ width: (m.avg_tps / maxOf(data.models.map(x => x.avg_tps)) * 48) + 'px' }"></span>
                  {{ m.avg_tps ?? '—' }}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <div class="card">
          <h3 class="c-title mono">活跃项目 · 按消息数</h3>
          <table>
            <thead>
              <tr><th>项目</th><th class="num">会话</th><th class="num">消息</th><th class="num">output</th></tr>
            </thead>
            <tbody>
              <tr v-for="p in data.projects" :key="p.project_path">
                <td class="mono name" :title="p.project_path">{{ shortPath(p.project_path) }}</td>
                <td class="num mono">{{ p.sessions }}</td>
                <td class="num mono">{{ p.messages.toLocaleString() }}</td>
                <td class="num mono">{{ fmtTokens(p.output_tokens) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
    </template>
  </div>
</template>

<style scoped>
.overview {
  height: 100%;
  overflow-y: auto;
  padding: 18px 20px 40px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.state { padding: 60px; text-align: center; color: var(--dim); }

.kpis { display: flex; gap: 10px; flex-wrap: wrap; }
.kpi {
  flex: 1;
  min-width: 130px;
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 6px;
  padding: 12px 14px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.k-label { font-size: 10px; letter-spacing: 0.08em; color: var(--faint); text-transform: uppercase; }
.k-label.pi { color: var(--pi); }
.k-label.claude { color: var(--claude); }
.k-label.codex { color: var(--codex); }
.k-value { font-size: 22px; font-weight: 600; font-variant-numeric: tabular-nums; }
.k-unit { font-size: 11px; color: var(--dim); font-weight: 400; }

.row { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
.card {
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 6px;
  padding: 14px 16px;
  min-width: 0;
}
.c-title { font-size: 10px; letter-spacing: 0.1em; color: var(--faint); text-transform: uppercase; margin-bottom: 10px; }

.chart { width: 100%; height: 90px; display: block; }
.bar { fill: var(--pi); opacity: 0.75; }
.bar.amber { fill: var(--amber); }
.bar.zero { fill: var(--line); opacity: 0.5; }

table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
th {
  text-align: left;
  font-size: 10px;
  font-weight: 500;
  letter-spacing: 0.06em;
  color: var(--faint);
  text-transform: uppercase;
  padding: 4px 8px 6px 0;
  border-bottom: 1px solid var(--line);
}
td { padding: 5px 8px 5px 0; border-bottom: 1px solid rgba(35, 42, 53, 0.5); }
tr:last-child td { border-bottom: none; }
.num { text-align: right; }
.name { max-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tps-cell { color: var(--amber); white-space: nowrap; }
.tps-bar {
  display: inline-block;
  height: 4px;
  background: var(--amber);
  opacity: 0.6;
  border-radius: 2px;
  margin-right: 6px;
  vertical-align: middle;
}

@media (max-width: 900px) {
  .row { grid-template-columns: 1fr; }
}
</style>
