<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { api, fmtTokens } from '../api'

interface Overview {
  today: { sessions: number; messages: number; input_tokens: number; output_tokens: number; cost: number }
  daily: { d: string; sessions: number; messages: number; output_tokens: number; input_tokens: number; cost: number }[]
  models: { model: string; sessions: number; output_tokens: number; avg_tps: number | null; cost: number | null }[]
  projects: { project_path: string; sessions: number; messages: number; output_tokens: number }[]
  agents: { agent: string; sessions: number; messages: number; input_tokens: number; output_tokens: number; avg_tps: number | null }[]
  active: { id: string; agent: string; title: string | null; model: string | null; message_count: number; ended_at: string }[]
  agentErrors: { agent: string; errors: number; sessions: number }[]
  topErrorSessions: { id: string; agent: string; title: string | null; error_count: number; message_count: number }[]
  riskSessions: { id: string; agent: string; title: string | null; n: number; rules: string; has_high: number }[]
  riskTotals: { total: number; high: number }
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
function fillDays(daily: Overview['daily'], key: 'sessions' | 'output_tokens' | 'cost') {
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

function fmtCost(c: number | null | undefined): string {
  if (c == null) return '—'
  if (c >= 100) return '$' + c.toFixed(0)
  if (c >= 1) return '$' + c.toFixed(1)
  return '$' + c.toFixed(2)
}

function maxOf(nums: (number | null)[]) {
  return Math.max(1, ...nums.map((n) => n ?? 0))
}
</script>

<template>
  <div class="overview">
    <div v-if="loading && !data" class="state">汇总中…</div>

    <template v-else-if="data">
      <!-- 进行中：5 分钟内有新消息 -->
      <section v-if="data.active.length" class="active-strip">
        <span class="live-dot" aria-hidden="true"></span>
        <span class="live-label mono">进行中 {{ data.active.length }}</span>
        <span v-for="a in data.active" :key="a.id" class="live-item mono" :class="a.agent">
          {{ (a.title ?? '(空会话)').slice(0, 36) }}
        </span>
      </section>

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
          <span class="k-label mono">今日成本</span>
          <span class="k-value cost">{{ fmtCost(data.today.cost) }}</span>
        </div>
        <div class="kpi" v-for="a in data.agents" :key="a.agent">
          <span class="k-label mono" :class="a.agent">{{ a.agent }} 均速</span>
          <span class="k-value">{{ a.avg_tps ?? '—' }}<span class="k-unit"> tok/s</span></span>
        </div>
        <div class="kpi">
          <span class="k-label mono">风险命中</span>
          <span class="k-value" :class="{ danger: data.riskTotals.high > 0 }">
            {{ data.riskTotals.total }}<span v-if="data.riskTotals.high" class="k-unit"> · {{ data.riskTotals.high }} 高危</span>
          </span>
        </div>
      </section>

      <!-- 趋势 -->
      <section class="row three">
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
        <div class="card">
          <h3 class="c-title mono">成本 / 天 · 近 30 天</h3>
          <svg :viewBox="`0 0 ${CHART_W} ${CHART_H}`" class="chart">
            <rect v-for="(b, i) in chartBars(fillDays(data.daily, 'cost'))" :key="i"
              :x="b.x" :y="b.y" :width="b.w" :height="b.h"
              :class="['bar green', { zero: b.v === 0 }]">
              <title>{{ b.d }} · {{ fmtCost(b.v) }}</title>
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
              <tr><th>模型</th><th class="num">会话</th><th class="num">output</th><th class="num">成本</th><th class="num">均速</th></tr>
            </thead>
            <tbody>
              <tr v-for="m in data.models" :key="m.model">
                <td class="mono name">{{ m.model }}</td>
                <td class="num mono">{{ m.sessions }}</td>
                <td class="num mono">{{ fmtTokens(m.output_tokens) }}</td>
                <td class="num mono cost">{{ fmtCost(m.cost) }}</td>
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
      <!-- 错误 / 风险 -->
      <section class="row">
        <div class="card">
          <h3 class="c-title mono">工具错误最多的会话</h3>
          <div v-if="!data.topErrorSessions.length" class="empty-note">没有工具错误记录</div>
          <table v-else>
            <tbody>
              <tr v-for="s in data.topErrorSessions" :key="s.id">
                <td class="mono name" :title="s.title ?? ''"><span class="agent-dot" :class="s.agent"></span>{{ (s.title ?? '(空会话)').slice(0, 40) }}</td>
                <td class="num mono danger-text">{{ s.error_count }} 错</td>
                <td class="num mono dim-text">/ {{ s.message_count }} 消息</td>
              </tr>
            </tbody>
          </table>
        </div>
        <div class="card">
          <h3 class="c-title mono">风险规则命中</h3>
          <div v-if="!data.riskSessions.length" class="empty-note">没有命中危险命令 / 密钥规则</div>
          <table v-else>
            <tbody>
              <tr v-for="s in data.riskSessions" :key="s.id">
                <td class="mono name" :title="s.title ?? ''"><span class="agent-dot" :class="s.agent"></span>{{ (s.title ?? '(空会话)').slice(0, 36) }}</td>
                <td class="mono rules">{{ s.rules }}</td>
                <td class="num mono" :class="s.has_high ? 'danger-text' : 'warn-text'">{{ s.n }}</td>
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
.row.three { grid-template-columns: 1fr 1fr 1fr; }
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
.bar.green { fill: var(--codex); }
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
  .row, .row.three { grid-template-columns: 1fr; }
}

/* 进行中横条 */
.active-strip {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  background: rgba(232, 163, 61, 0.06);
  border: 1px solid rgba(232, 163, 61, 0.35);
  border-radius: 6px;
  padding: 8px 14px;
}
.live-dot {
  width: 7px; height: 7px; border-radius: 50%;
  background: var(--amber);
  animation: pulse 1.6s ease-in-out infinite;
}
@keyframes pulse { 50% { opacity: 0.25; } }
.live-label { font-size: 11px; color: var(--amber); letter-spacing: 0.06em; }
.live-item {
  font-size: 11px;
  color: var(--dim);
  background: var(--panel-2);
  border-radius: 4px;
  padding: 2px 8px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 260px;
}

.k-value.cost { color: var(--codex); }
.k-value.danger { color: var(--danger); }
td.cost { color: var(--codex); }
.danger-text { color: var(--danger); }
.warn-text { color: var(--amber); }
.dim-text { color: var(--faint); }
.rules { font-size: 10.5px; color: var(--dim); max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* 底部两张卡片表格：列多时任由 max-width:0 压缩会把标题挤没，给固定上限 */
.row:last-child td.name { max-width: 340px; }
.empty-note { padding: 14px 0; font-size: 12px; color: var(--faint); }
.agent-dot {
  display: inline-block;
  width: 6px; height: 6px;
  border-radius: 50%;
  margin-right: 7px;
}
.agent-dot.pi { background: var(--pi); }
.agent-dot.claude { background: var(--claude); }
.agent-dot.codex { background: var(--codex); }
</style>
