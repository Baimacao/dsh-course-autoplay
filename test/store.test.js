import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { CourseStore, idFromUrl } from '../lib/store.js'

function tempStore() {
  return new CourseStore(mkdtempSync(join(tmpdir(), 'autoplay-')))
}

test('加站点后能读回来，并按域名自动匹配经验', () => {
  const store = tempStore()
  const site = store.addSite({ listUrl: 'https://www.hnzjpx.cn/235/subject', profileId: 'hnzjpx' })
  assert.equal(store.sites().length, 1)
  assert.equal(store.sites()[0].profileId, 'hnzjpx')
  assert.equal(site.id, 'hnzjpx-cn-235')
})

test('重复 id 被拒绝', () => {
  const store = tempStore()
  store.addSite({ id: 'a', listUrl: 'https://x.cn/y' })
  assert.throws(() => store.addSite({ id: 'a', listUrl: 'https://x.cn/z' }), /同 id/)
})

test('非法地址被拒绝', () => {
  const store = tempStore()
  assert.throws(() => store.addSite({ listUrl: 'file:///c/x' }), /http/)
})

test('状态按站点分开存', () => {
  const store = tempStore()
  store.addSite({ id: 'a', listUrl: 'https://x.cn/y' })
  store.addSite({ id: 'b', listUrl: 'https://x.cn/z' })
  store.saveState('a', { session: 's1' })
  store.saveState('b', { session: 's2' })
  assert.equal(store.state('a').session, 's1')
  assert.equal(store.state('b').session, 's2')
})

test('删站点会带走它的状态', () => {
  const store = tempStore()
  store.addSite({ id: 'a', listUrl: 'https://x.cn/y' })
  store.saveState('a', { session: 's1' })
  store.removeSite('a')
  assert.equal(store.sites().length, 0)
  assert.deepEqual(store.state('a'), {})
})

test('坏掉的 sites.json 会被报出来，不当成空配置', () => {
  const store = tempStore()
  writeFileSync(join(store.dir, 'sites.json'), '{ broken', 'utf8')
  assert.deepEqual(store.sites(), [])
  assert.deepEqual(store.corrupt, ['sites.json'])
})

test('写配置不留下半截文件', () => {
  const store = tempStore()
  store.addSite({ id: 'a', listUrl: 'https://x.cn/y' })
  assert.doesNotThrow(() => JSON.parse(readFileSync(join(store.dir, 'sites.json'), 'utf8')))
})

test('idFromUrl 对畸形地址也能给出 id', () => {
  assert.match(idFromUrl('not a url'), /^site-/)
  assert.equal(idFromUrl('https://www.hnzjpx.cn/235/subject'), 'hnzjpx-cn-235')
})
