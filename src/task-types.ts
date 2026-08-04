// 会话任务分类：按标题（含首条用户消息摘要）规则归类，用于「什么任务用什么模型」的路由分析
// 纯规则确定性分类，顺序即优先级（命中最具体的先归）

export type TaskType = 'bugfix' | 'feature' | 'docs' | 'analysis' | 'refactor' | 'other'

export const TASK_LABEL: Record<TaskType, string> = {
  bugfix: '调试修 bug',
  feature: '新功能开发',
  docs: '文档报告',
  analysis: '分析调研',
  refactor: '重构优化',
  other: '其他',
}

const RULES: [TaskType, RegExp][] = [
  ['bugfix', /报错|错误|修[一理下]?|bug|不行|挂了|失败|崩溃|fix|修复|排查|异常/i],
  ['docs', /周报|文档|报告|PPT|总结|讲义|幻灯|README|readme|手册|markdown/i],
  ['refactor', /重构|优化|refactor|清理|精简|拆分|解耦/i],
  ['feature', /实现|开发|功能|新增|做个|做一|搭建|接入|支持|feat|加个|增加/i],
  ['analysis', /分析|调研|对比|评估|怎么看|建议|方案|选型|梳理|了解一下|解释/i],
]

export function classifyTask(title: string | null | undefined): TaskType {
  if (!title) return 'other'
  for (const [type, re] of RULES) {
    if (re.test(title)) return type
  }
  return 'other'
}
