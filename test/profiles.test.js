import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ProfileStore, hostOf, domainKeyOf } from '../lib/profiles.js'

const hzUrl = 'https://www.hnzjpx.cn/235/subject'

test('内置经验能读出来', () => {
  const store = new ProfileStore(mkdtempSync(join(tmpdir(), 'prof-')))
  const ids = store.all().map((p) => p.id).sort()
  assert.deepEqual(ids, ['hnzjpx', 'hunnu'])
})

test('按精确主机名匹配', () => {
  const store = new ProfileStore(mkdtempSync(join(tmpdir(), 'prof-')))
  assert.equal(store.match(hzUrl)?.id, 'hnzjpx')
})

test('子域不同时退到域名尾两段', () => {
  const store = new ProfileStore(mkdtempSync(join(tmpdir(), 'prof-')))
  assert.equal(store.match('https://m.hnzjpx.cn/235/subject')?.id, 'hnzjpx')
})

test('陌生站点匹配不到，返回 undefined 而不是乱猜', () => {
  const store = new ProfileStore(mkdtempSync(join(tmpdir(), 'prof-')))
  assert.equal(store.match('https://example.org/course'), undefined)
})

test('学到的经验同名覆盖内置', () => {
  const store = new ProfileStore(mkdtempSync(join(tmpdir(), 'prof-')))
  store.save({ id: 'hnzjpx', domain: 'www.hnzjpx.cn', name: '改过的', listPage: {}, playerPage: {} })
  const hit = store.get('hnzjpx')
  assert.equal(hit.name, '改过的')
  assert.equal(hit.source, 'learned')
})

test('坏经验文件会被报出来，不当成没有', () => {
  const store = new ProfileStore(mkdtempSync(join(tmpdir(), 'prof-')))
  writeFileSync(join(store.dir, 'broken.json'), '{ nope', 'utf8')
  store.all()
  assert.equal(store.corrupt.length, 1)
  assert.match(store.corrupt[0], /broken\.json/)
})

test('保存不留半截文件', () => {
  const store = new ProfileStore(mkdtempSync(join(tmpdir(), 'prof-')))
  store.save({ id: 'x', domain: 'x.test', listPage: {}, playerPage: {} })
  const names = readdirSync(store.dir)
  assert.equal(names.filter((n) => n.endsWith('.tmp')).length, 0)
})

test('hostOf / domainKeyOf 处理畸形地址', () => {
  assert.equal(hostOf('not a url'), '')
  assert.equal(domainKeyOf('not a url'), '')
  assert.equal(domainKeyOf('https://a.b.example.co.uk/x'), 'co.uk')
})
