<script setup lang="ts">
import { computed, ref } from 'vue'
import { fmtTime, type Review, type ReviewFinding } from '../api'

const props = defineProps<{ reviews: Review[] }>()

const showHistory = ref(false)

const latest = computed(() => props.reviews[0] ?? null)
const history = computed(() => props.reviews.slice(1))

const VERDICT = {
  good: { label: '干得不错', cls: 'good' },
  mixed: { label: '喜忧参半', cls: 'mixed' },
  problematic: { label: '问题不小', cls: 'bad' },
} as const

const FINDING_LABEL: Record<ReviewFinding['type'], string> = {
  rework: '返工',
  correction: '用户纠正',
  misunderstanding: '理解偏差',
  good_practice: '亮点',
  lesson: '经验',
  risk: '风险',
}

const SOURCE_LABEL: Record<string, string> = {
  'spectator-engine': 'spectator',
  'pi-plugin': 'pi 自查',
  'claude-plugin': 'claude 自查',
  'codex-plugin': 'codex 自查',
  manual: '手动',
}
</script>

<template>
  <section v-if="latest" class="reviews">
    <!-- 最新复盘 -->
    <article class="review-card" :class="VERDICT[latest.verdict].cls">
      <header class="r-head">
        <span class="verdict mono" :class="VERDICT[latest.verdict].cls">{{ VERDICT[latest.verdict].label }}</span>
        <span class="r-meta mono">
          {{ SOURCE_LABEL[latest.source] ?? latest.source }}
          <template v-if="latest.model"> · {{ latest.model }}</template>
           · {{ fmtTime(latest.created_at) }}
        </span>
      </header>
      <p v-if="latest.summary" class="r-summary">{{ latest.summary }}</p>
      <ul v-if="latest.findings.length" class="r-findings">
        <li v-for="(f, i) in latest.findings" :key="i">
          <span class="f-tag mono" :class="f.type">{{ FINDING_LABEL[f.type] ?? f.type }}</span>
          <span class="f-detail">{{ f.detail }}<span v-if="f.evidence" class="f-evidence">（{{ f.evidence }}）</span></span>
        </li>
      </ul>
    </article>

    <!-- 历史复盘折叠 -->
    <button v-if="history.length" class="history-toggle mono" @click="showHistory = !showHistory">
      {{ showHistory ? '▾' : '▸' }} {{ history.length }} 条历史复盘
    </button>
    <template v-if="showHistory">
      <article v-for="r in history" :key="r.id" class="review-card old" :class="VERDICT[r.verdict].cls">
        <header class="r-head">
          <span class="verdict mono" :class="VERDICT[r.verdict].cls">{{ VERDICT[r.verdict].label }}</span>
          <span class="r-meta mono">{{ SOURCE_LABEL[r.source] ?? r.source }} · {{ fmtTime(r.created_at) }}</span>
        </header>
        <p v-if="r.summary" class="r-summary">{{ r.summary }}</p>
      </article>
    </template>
  </section>
</template>

<style scoped>
.reviews { padding: 12px 20px 4px; }

.review-card {
  background: var(--panel);
  border: 1px solid var(--line);
  border-left-width: 3px;
  border-radius: 6px;
  padding: 12px 16px;
}
.review-card.good { border-left-color: var(--codex); }
.review-card.mixed { border-left-color: var(--amber); }
.review-card.bad { border-left-color: var(--danger); }
.review-card.old { margin-top: 8px; opacity: 0.75; }

.r-head { display: flex; align-items: baseline; gap: 10px; margin-bottom: 6px; }
.verdict { font-size: 11px; font-weight: 500; letter-spacing: 0.04em; }
.verdict.good { color: var(--codex); }
.verdict.mixed { color: var(--amber); }
.verdict.bad { color: var(--danger); }
.r-meta { font-size: 10.5px; color: var(--faint); }

.r-summary { font-size: 13px; line-height: 1.6; color: var(--text); margin-bottom: 8px; }

.r-findings { list-style: none; display: flex; flex-direction: column; gap: 5px; }
.r-findings li { display: flex; gap: 8px; align-items: baseline; font-size: 12.5px; }
.f-tag {
  flex-shrink: 0;
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 3px;
  background: var(--panel-2);
  color: var(--dim);
}
.f-tag.rework, .f-tag.correction, .f-tag.misunderstanding { color: var(--amber); }
.f-tag.lesson, .f-tag.good_practice { color: var(--codex); }
.f-tag.risk { color: var(--danger); }
.f-detail { color: var(--text); line-height: 1.55; }
.f-evidence { color: var(--faint); font-size: 11px; }

.history-toggle {
  margin-top: 8px;
  background: none;
  border: none;
  color: var(--dim);
  font-size: 11px;
  padding: 2px 0;
}
.history-toggle:hover { color: var(--text); }
</style>
