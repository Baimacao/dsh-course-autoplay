import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { makeLogger } from '../lib/log.js'

test('写进去能读回来，按行倒着取', () => {
  const dir = mkdtempSync(join(tmpdir(), 'autoplay-log-'))
  const logger = makeLogger(dir)
  logger.line('a', '第一行')
  logger.line('b', '第二行')
  const tail = logger.tail(5)
  assert.equal(tail.length, 2)
  assert.match(tail[1], /第二行/)
})

test('超过上限会轮转并留下说明，不静默丢弃', () => {
  const dir = mkdtempSync(join(tmpdir(), 'autoplay-log-'))
  const logger = makeLogger(dir, { maxBytes: 120 })
  for (let i = 0; i < 20; i += 1) logger.line('x', '填充行 ' + i)
  assert.match(readFileSync(join(dir, 'run.log'), 'utf8'), /已轮转/)
})
