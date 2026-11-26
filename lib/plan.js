// 计划：把「挂了哪些站、每站到哪了、下一阶段做什么」落成文档。
//
// 两种产物：
//   plan.md   给人看（也给我自己看）——阶段、待办、目标、进度
//   plan.json 机器读——面板据此渲染，不用再解析 markdown
//
// 目标（goal）不是装饰：它决定还跑不跑。学时的意义是「该学到的东西学完」，
// 所以目标写成「X 站共 N 门全部完成」，而不是「跑满多少小时」。
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

function writeAtomic(file, text) {
  const tmp = file + '.tmp'
  writeFileSync(tmp, text, 'utf8')
  renameSync(tmp, file)
}

/** 一站的阶段：还没开始 / 在推进 / 已完成 / 卡住。 */
export function stageOf(state) {
  if (!state || !state.progress) return { key: 'idle', label: '未开始' }
  const p = state.progress
  if (state.lastError && state.lastErrorAt) {
    const since = Date.now() - Date.parse(state.lastErrorAt)
    if (Number.isFinite(since) && since < 30 * 60_000) return { key: 'stuck', label: '卡住' }
  }
  if (p.total > 0 && p.done >= p.total) return { key: 'done', label: '已完成' }
  if (p.done > 0 || Number(state.stuck ?? 0) > 0) return { key: 'running', label: '进行中' }
  return { key: 'idle', label: '未开始' }
}

/** 从站点状态建一份计划文档。 */
export function buildPlan({ sites, states, title, notes }) {
  const rows = sites.map((site) => {
    const state = states[site.id] ?? {}
    const stage = stageOf(state)
    const p = state.progress ?? {}
    return { site, state, stage, progress: p }
  })

  const totals = rows.reduce((acc, r) => {
    if (typeof r.progress.total === 'number' && r.progress.total > 0) {
      acc.done += Number(r.progress.done ?? 0)
      acc.total += r.progress.total
    }
    return acc
  }, { done: 0, total: 0 })

  const finished = rows.filter((r) => r.stage.key === 'done').length
  const goal = {
    text: title || ('完成 ' + rows.length + ' 个站点的课程'),
    progress: { done: totals.done, total: totals.total },
    reached: rows.length > 0 && finished === rows.length,
  }

  const todos = rows.map((r) => ({
    siteId: r.site.id,
    label: r.site.label || r.site.id,
    stage: r.stage.key,
    stageLabel: r.stage.label,
    done: r.progress.done ?? 0,
    total: r.progress.total ?? 0,
    note: r.state.lastNote ?? '',
    error: r.state.lastError ?? '',
  }))

  const lines = []
  lines.push('# 挂课计划')
  lines.push('')
  lines.push('目标：' + goal.text)
  if (goal.progress.total > 0) {
    lines.push('进度：' + goal.progress.done + '/' + goal.progress.total + (goal.reached ? '（已达成）' : ''))
  }
  lines.push('更新时间：' + new Date().toLocaleString('zh-CN', { hour12: false }))
  lines.push('')
  lines.push('## 阶段')
  lines.push('')
  for (const r of rows) {
    const total = r.progress.total ?? 0
    const done = r.progress.done ?? 0
    lines.push('### ' + (r.site.label || r.site.id) + ' — ' + r.stage.label)
    lines.push('')
    if (total > 0) {
      const pct = Math.round((done / total) * 100)
      lines.push('- 进度：' + done + '/' + total + '（' + pct + '%）')
    } else {
      lines.push('- 进度：还没读到条目数')
    }
    if (r.state.lastNote) lines.push('- 最近：' + r.state.lastNote)
    if (r.state.updatedAt) lines.push('- 更新：' + r.state.updatedAt)
    if (r.state.lastError) lines.push('- 卡在：' + r.state.lastError)
    lines.push('')
  }
  if (Array.isArray(notes) && notes.length > 0) {
    lines.push('## 备注')
    lines.push('')
    for (const n of notes) lines.push('- ' + n)
    lines.push('')
  }

  return { markdown: lines.join('\n'), json: { goal, todos, totals, finished, generatedAt: new Date().toISOString() } }
}

export class PlanWriter {
  constructor(dataDir) {
    this.dir = dataDir
    this.md = join(dataDir, 'plan.md')
    this.json = join(dataDir, 'plan.json')
    mkdirSync(dataDir, { recursive: true })
  }

  write(plan) {
    writeAtomic(this.md, plan.markdown + '\n')
    writeAtomic(this.json, JSON.stringify(plan.json, null, 2) + '\n')
    return { md: this.md, json: this.json }
  }

  read() {
    try {
      return { markdown: readFileSync(this.md, 'utf8'), json: JSON.parse(readFileSync(this.json, 'utf8')) }
    } catch {
      return null
    }
  }

  exists() {
    return existsSync(this.md) && existsSync(this.json)
  }
}
