import test from 'node:test'
import assert from 'node:assert/strict'
import { stepSite } from '../lib/runner.js'
import { probeScript } from '../lib/engine.js'

const profile = {
  id: 'p1', domain: 'x.cn',
  listPage: {},
  playerPage: {
    videoSelector: 'video',
    lesson: { selector: '.playlist__lesson', activeClass: '--active', doneClass: '--done', hrefAttr: 'href' },
  },
}

test('stepSite 用探针结果推进并落状态', async () => {
  const calls = []
  const driver = {
    async startSession(name) { calls.push(['start', name]); return { session_id: 's1' } },
    async evaluate(session, expr) {
      calls.push(['eval', session])
      if (expr === probeScript(profile)) {
        return {
          url: 'https://x.cn/a/play', title: 'T', mode: 'player',
          video: { t: 10, d: 600, paused: true },
          lessons: [{ i: 0, done: true }, { i: 1, done: false, active: true }],
        }
      }
      return { ok: true }
    },
  }
  const lines = []
  const log = { line: (tag, msg) => lines.push(tag + ': ' + msg) }
  const site = { id: 'h', listUrl: 'https://x.cn/a/list' }
  const { state } = await stepSite(driver, site, profile, {}, log)
  assert.equal(state.session, 's1')
  assert.equal(state.stuck, 0)
  assert.equal(state.progress.kind, 'lessons')
  assert.equal(state.profileId, 'p1')
  assert.ok(state.nextDelayMs > 0)
  assert.ok(lines.length > 0)
})

test('拿不到视频时时长累计卡住次数', async () => {
  const driver = {
    async startSession() { return { session_id: 's1' } },
    async evaluate(_s, expr) {
      if (expr === probeScript(profile)) {
        return { url: 'https://x.cn/a/play', title: 'T', mode: 'player', video: null, lessons: [{ i: 0, done: false, active: true }] }
      }
      return { ok: true }
    },
  }
  const log = { line: () => {} }
  const site = { id: 'h', listUrl: 'https://x.cn/a/list' }
  const { state } = await stepSite(driver, site, profile, { stuck: 2 }, log)
  assert.equal(state.stuck, 3)
})

test('列表页读到结构时不算卡住', async () => {
  const driver = {
    async startSession() { return { session_id: 's1' } },
    async evaluate(_s, expr) {
      if (expr === probeScript(profile)) {
        return { url: 'https://x.cn/a/list', mode: 'list', video: null, rows: [{ i: 0, pct: 0 }] }
      }
      return { ok: true }
    },
  }
  const site = { id: 'h', listUrl: 'https://x.cn/a/list' }
  const { state } = await stepSite(driver, site, profile, { stuck: 3 }, { line: () => {} })
  assert.equal(state.stuck, 0)
})
