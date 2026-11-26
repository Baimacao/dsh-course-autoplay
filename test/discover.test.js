import test from 'node:test'
import assert from 'node:assert/strict'
import { SNIFF, draftFrom, usable, normalizeSelector } from '../lib/discover.js'

const site = { id: 'x', listUrl: 'https://www.example.cn/1/subject' }

test('SNIFF 是能解析的表达式', () => {
  assert.match(SNIFF, /^\(\(\) => \{/)
  assert.equal((SNIFF.match(/\$\{/g) || []).length, 0)
  assert.match(SNIFF, /querySelectorAll\('video'\)/)
})

test('从带百分比的列表猜出列表页结构', () => {
  const draft = draftFrom({
    url: 'https://www.example.cn/1/subject',
    title: '某培训平台',
    videos: [],
    candidates: [
      { text: '立即学习', tag: 'button', cls: 'btn', pct: 40 },
      { text: '立即学习', tag: 'button', cls: 'btn', pct: 100 },
      { text: '立即学习', tag: 'button', cls: 'btn', pct: 0 },
    ],
    groups: [],
    counters: [],
  }, site)
  assert.ok(draft)
  assert.equal(draft.domain, 'www.example.cn')
  assert.equal(draft.listPage.row.clickSelector, 'button')
  assert.equal(draft.listPage.row.clickText, '立即学习')
  assert.equal(usable(draft).ok, true)
})

test('只有视频的页面：认成单集，不编造列表结构', () => {
  const draft = draftFrom({
    url: 'https://v.example.cn/watch',
    title: '一节课',
    videos: [{ i: 0, d: 600, t: 10 }],
    candidates: [],
    groups: [],
    counters: [],
  }, { id: 'x', listUrl: 'https://v.example.cn/watch' })
  assert.ok(draft)
  assert.equal(draft.listPage.row, undefined)
  assert.equal(draft.playerPage.videoSelector, 'video')
})

test('什么特征都没有时返回 null，不自作聪明', () => {
  assert.equal(draftFrom({ url: 'https://a.cn/x', videos: [], candidates: [], groups: [], counters: [] }, site), null)
})

test('畸形 URL 返回 null 而不是抛错', () => {
  assert.equal(draftFrom({ url: '???', videos: [], candidates: [{ text: 'a', tag: 'button', cls: '', pct: 1 }, { text: 'a', tag: 'button', cls: '', pct: 2 }] }, site), null)
})

test('usable 对缺 videoSelector 的草稿说不', () => {
  assert.equal(usable({ listPage: { row: { clickSelector: 'button' } }, playerPage: {} }).ok, false)
  assert.equal(usable(null).ok, false)
})

test('单个候选不构成列表经验', () => {
  const draft = draftFrom({
    url: 'https://b.cn/x', videos: [{ i: 0, d: 1 }],
    candidates: [{ text: '开始', tag: 'button', cls: '', pct: 10 }], groups: [], counters: [],
  }, site)
  assert.ok(draft)
  assert.equal(draft.listPage.row, undefined)
})

test('选择器校验只放行合法 CSS', () => {
  assert.equal(normalizeSelector('.section_list .section'), '.section_list .section')
  assert.equal(normalizeSelector('div a'), 'div a')
  assert.equal(normalizeSelector('@@##'), '')
  assert.equal(normalizeSelector(''), '')
  assert.equal(normalizeSelector('script>alert(1)'), '')
})

test('嗅探到同类兄弟列表时给出可用的小节选择器', () => {
  const draft = draftFrom({
    url: 'https://c.cn/play', videos: [{ i: 0, d: 600 }],
    candidates: [], counters: [],
    groups: [{ selector: '.section_list .section', n: 5 }, { selector: '.x .y', n: 3 }],
  }, site)
  assert.ok(draft)
  assert.equal(draft.playerPage.section.selector, '.section_list .section')
  assert.equal(usable(draft).ok, true, '有大节列表就该算能用')
})

test('小节草稿没还原出 selector 时不算能用', () => {
  const draft = draftFrom({
    url: 'https://d.cn/play', videos: [{ i: 0, d: 600 }],
    candidates: [], counters: [], groups: [{ selector: '@@##', n: 9 }],
  }, site)
  assert.ok(draft)
  assert.equal(draft.playerPage.section, undefined)
})
