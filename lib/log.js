// 运行日志：一行一条追加写。
// 日志写不进去绝不能把主循环带崩，但也不能静默——所以读日志的工具会显示文件路径和错误。
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const DEFAULT_MAX_BYTES = 2 * 1024 * 1024

function stamp() {
  const d = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
    ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds())
}

/**
 * 建一个写文件的 logger。
 * @param {string} dir 日志目录
 * @param {{ maxBytes?: number }} [options]
 */
export function makeLogger(dir, options = {}) {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
  const file = join(dir, 'run.log')

  function rotateIfNeeded() {
    try {
      if (!existsSync(file)) return
      const size = statSync(file).size
      if (size <= maxBytes) return
      // 轮转时先写一行标记，否则清空这件事本身就成了静默行为
      writeFileSync(file, stamp() + ' [log] 日志超过 ' + maxBytes + ' 字节，已轮转（更早的内容不再保留）\n', 'utf8')
    } catch { /* 轮转失败不阻断写入 */ }
  }

  return {
    file,
    dir,
    /** 追加一行。返回写进去的原文，方便调用方顺手带走。 */
    line(tag, message) {
      const text = stamp() + ' [' + tag + '] ' + message
      try {
        mkdirSync(dir, { recursive: true })
        rotateIfNeeded()
        appendFileSync(file, text + '\n', 'utf8')
      } catch { /* 写不了就只返回文本，不抛 */ }
      return text
    },
    /** 读最后 n 行。文件不在就返回空数组。 */
    tail(n = 40) {
      try {
        if (!existsSync(file)) return []
        const text = readFileSync(file, 'utf8')
        const lines = text.split('\n').filter((l) => l.length > 0)
        return lines.slice(-Math.max(1, n))
      } catch {
        return []
      }
    },
  }
}
