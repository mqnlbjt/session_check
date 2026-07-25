<script setup lang="ts">
// 会话心电条：把会话时长切成若干时间桶，每个桶的高度 = 消息密度
// 这是 session 行的签名元素——一眼看出会话节奏（密集冲刺 / 稀疏长跑）
const props = withDefaults(defineProps<{ data: number[]; bins?: number }>(), { bins: 32 })

const W = 120, H = 18

function bars() {
  const bins = props.bins
  const data = props.data?.length ? props.data : []
  const max = Math.max(1, ...data)
  const bw = W / bins
  return Array.from({ length: bins }, (_, i) => {
    const v = data[i] ?? 0
    const h = v === 0 ? 1 : Math.max(2, (v / max) * H)
    return { x: i * bw, y: H - h, w: Math.max(1, bw - 1), h, active: v > 0 }
  })
}
</script>

<template>
  <svg class="spark" :viewBox="`0 0 ${W} ${H}`" preserveAspectRatio="none" aria-hidden="true">
    <rect
      v-for="(b, i) in bars()" :key="i"
      :x="b.x" :y="b.y" :width="b.w" :height="b.h"
      :class="{ active: b.active }"
    />
  </svg>
</template>

<style scoped>
.spark { width: 100%; height: 18px; display: block; }
.spark rect { fill: var(--line); }
.spark rect.active { fill: var(--amber); opacity: 0.85; }
</style>
