import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { buildPlan, PlanWriter, stageOf } from '../lib/plan.js'

test('阶段判定：未开始 / 进行中 / 已完成 / 卡住', () => {
  assert.equal(stageOf({}).key, 'idle')
  assert.equal(stageOf({ progress: { done: 1, total: 10 } }).key, 'running')
  assert.equal(stageOf({ progress: { done: 10, total: 10 } }).key, 'done')
  assert.equal(stageOf({ progress: { done: 1, total: 10 }, lastError: 'x', lastErrorAt: new Date().toISOString() }).key, 'stuck')
  // 老错误（30 分钟前）不再算卡住
  assert.equal(stageOf({ progress: { done: 1, total: 10 }, lastError: 'x', lastErrorAt: new Date(Date.now() - 3600_000).toISOString() }).key, 'running')
})

test('计划文档带目标、阶段和待办', () => {
  const plan = buildPlan({
    sites: [
      { id: 'a', label: '衡阳', listUrl: 'https://a' },
      { id: 'b', label: '师大', listUrl: 'https://b' },
    ],
    states: {
      a: { progress: { done: 12, total: 12 }, lastNote: '全部完成' },
      b: { progress: { done: 3, total: 99 }, lastNote: '第 4 讲' },
    },
    title: '两站全部完成',
  })
  assert.match(plan.markdown, /# 挂课计划/)
  assert.match(plan.markdown, /目标：两站全部完成/)
  assert.match(plan.markdown, /15\/111/)
  assert.equal(plan.json.todos.length, 2)
  assert.equal(plan.json.goal.reached, false)
  assert.equal(plan.json.finished, 1)
})

test('全部完成时目标标记为达成', () => {
  const plan = buildPlan({
    sites: [{ id: 'a', label: 'A', listUrl: 'https://a' }],
    states: { a: { progress: { done: 5, total: 5 } } },
  })
  assert.equal(plan.json.goal.reached, true)
  assert.match(plan.markdown, /已达成/)
})

test('没有进度数据时不装作有', () => {
  const plan = buildPlan({ sites: [{ id: 'a', label: 'A', listUrl: 'https://a' }], states: {} })
  assert.match(plan.markdown, /还没读到条目数/)
  assert.equal(plan.json.goal.progress.total, 0)
})

test('PlanWriter 写两份文件且不留半截', () => {
  const dir = mkdtempSync(join(tmpdir(), 'plan-'))
  const w = new PlanWriter(dir)
  const plan = buildPlan({ sites: [{ id: 'a', label: 'A', listUrl: 'https://a' }], states: { a: { progress: { done: 1, total: 2 } } } })
  const written = w.write(plan)
  assert.ok(w.exists())
  const back = w.read()
  assert.match(back.markdown, /1\/2/)
  assert.equal(back.json.goal.progress.total, 2)
  assert.doesNotThrow(() => JSON.parse(readFileSync(written.json, 'utf8')))
})

test('没写目标时自动生成一句（含已知条目数）', async () => {
  const mod = await import('../index.js')
  // index.js 需要宿主包，这里只测纯函数行为：用一个假 store
  const fake = {
    sites: () => [{ id: 'a', label: '衡阳' }, { id: 'b', label: '师大' }],
    state: (id) => (id === 'a' ? { progress: { done: 1, total: 12 } } : { progress: { done: 2, total: 99 } }),
  }
  const title = mod.autoGoalTitle(fake)
  assert.match(title, /衡阳/)
  assert.match(title, /111/)
})

test('没站点时目标直接说没有', async () => {
  const mod = await import('../index.js')
  assert.equal(mod.autoGoalTitle({ sites: () => [], state: () => ({}) }), '还没有站点')
})
