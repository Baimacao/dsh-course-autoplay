import test from 'node:test'
import assert from 'node:assert/strict'
import { probeScript, plan, summarize, PLAY } from '../lib/engine.js'

const hz = {
  id: 'hnzjpx', domain: 'www.hnzjpx.cn',
  listPage: { row: { clickSelector: 'button', clickText: '立即学习', blockUp: 6, blockMustContain: '学习进度', progressRegex: '([0-9]+)%' } },
  playerPage: { videoSelector: 'video', section: { selector: '.section_list .section', activeClass: 'active', doneText: '已完成' } },
}

const hn = {
  id: 'hunnu', domain: 'zjjxjy.hunnu.edu.cn',
  listPage: {},
  playerPage: {
    videoSelector: 'video',
    lesson: { selector: '.playlist__lesson', activeClass: '--active', doneClass: '--done', hrefAttr: 'href' },
    counterRegex: '已学完\\s*([0-9]+)\\s*/\\s*([0-9]+)',
  },
}

test('probeScript 是个能解析的表达式，且不含未转义的插值', () => {
  const script = probeScript(hz)
  assert.match(script, /^\(\(\) => \{/)
  assert.equal((script.match(/\$\{/g) || []).length, 0)
  // 站点给的选择器必须被 JSON 化，不能裸拼
  const hnScript = probeScript(hn)
  assert.match(hnScript, /\.playlist__lesson/)
  assert.match(hnScript, /--done/)
})

test('probeScript 对空经验也能产出可解析的脚本', () => {
  const script = probeScript({ id: 'x', domain: 'x', listPage: {}, playerPage: {} })
  assert.match(script, /querySelector\("video"\)/)
  assert.match(script, /return out/)
})

test('列表页：挑第一门没满 100% 的', () => {
  const p = plan({ rows: [{ i: 0, pct: 100, title: 'A' }, { i: 1, pct: 40, title: 'B' }] }, { listUrl: 'https://x/list' })
  assert.equal(p.action, 'click')
  assert.equal(p.index, 1)
})

test('列表页全完成：歇着', () => {
  const p = plan({ rows: [{ i: 0, pct: 100 }] }, { listUrl: 'https://x/list' })
  assert.equal(p.action, 'stay')
  assert.ok(p.delayMs >= 60000)
})

test('小节页：切到未完成小节', () => {
  const p = plan({
    sections: [{ i: 0, done: true, active: false }, { i: 1, done: false, active: false }],
    video: { t: 10, d: 600 },
  }, { listUrl: 'https://x/list' })
  assert.equal(p.action, 'click')
  assert.equal(p.index, 1)
})

test('小节页：当前小节在播就继续播', () => {
  const p = plan({
    sections: [{ i: 0, done: false, active: true }],
    video: { t: 300, d: 1875 },
  }, { listUrl: 'https://x/list' })
  assert.equal(p.action, 'play')
  assert.match(p.note, /16%/)
})

test('讲次页：当前讲完成就点下一讲', () => {
  const p = plan({
    lessons: [{ i: 0, done: true, active: true }, { i: 1, done: false }],
    video: { t: 600, d: 600 },
  }, { listUrl: 'https://x/list' })
  assert.equal(p.action, 'click')
  assert.equal(p.index, 1)
})

test('讲次页：没视频先试着播，不当作完成', () => {
  const p = plan({ lessons: [{ i: 0, done: false, active: true }], video: null }, { listUrl: 'https://x/list' })
  assert.equal(p.action, 'play')
})

test('连续卡住会重载', () => {
  const p = plan({ lessons: [{ i: 0, done: false, active: true }], video: null, url: 'https://x/p' }, { listUrl: 'https://x/list' }, { stuck: 4 })
  assert.equal(p.action, 'open')
})

test('只有视频的单集页：播完就歇着', () => {
  // 距结束还有 10 秒，还在播；播到末尾 3 秒内才算这一集完了
  assert.equal(plan({ video: { t: 590, d: 600 } }, { listUrl: 'https://x' }).action, 'play')
  assert.equal(plan({ video: { t: 599, d: 600 } }, { listUrl: 'https://x' }).action, 'stay')
  assert.equal(plan({ video: { t: 10, d: 600 } }, { listUrl: 'https://x' }).action, 'play')
})

test('什么都没有：回列表页，不假装在推进', () => {
  const p = plan({ video: null }, { listUrl: 'https://x/list' })
  assert.equal(p.action, 'open')
  assert.equal(p.url, 'https://x/list')
})

test('探针结果是 null 也不崩', () => {
  assert.equal(plan(null, { listUrl: 'https://x/list' }).action, 'open')
})

test('summarize 认四种页面', () => {
  assert.equal(summarize({ rows: [{ pct: 100 }, { pct: 30 }] }).done, 1)
  assert.equal(summarize({ sections: [{ done: true }, { done: false }] }).kind, 'sections')
  assert.equal(summarize({ lessons: [{ done: true }], counter: { done: 3, total: 9 } }).platformTotal, 9)
  assert.equal(summarize({ video: { t: 1, d: 100 } }).kind, 'video')
  assert.equal(summarize({}).kind, 'unknown')
})

test('PLAY 固定 1 倍速', () => {
  assert.match(PLAY, /playbackRate !== 1/)
  assert.match(PLAY, /playbackRate = 1/)
})
