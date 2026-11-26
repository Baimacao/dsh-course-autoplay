// 站点经验的存取与匹配。
//
// 两个来源，同一份格式：
//   lib/profiles/*.json        内置（随插件发布，只读）
//   <dataDir>/profiles/*.json  学到的（自适应写入，可手改、可删除）
//
// 同名 id 时学到的覆盖内置——内置经验写错了，用户改一份同名文件就能顶掉，
// 不用等插件发新版。
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const BUILTIN_DIR = join(HERE, 'profiles')

/** 从 URL 取主机名，取不到返回空串。 */
export function hostOf(url) {
  try {
    return new URL(String(url)).host.toLowerCase()
  } catch {
    return ''
  }
}

/** 主机名最后两段（www.a.b.cn → b.cn），用于「同一家站点的不同子域」复用经验。 */
export function domainKeyOf(url) {
  const host = hostOf(url)
  if (!host) return ''
  const parts = host.split('.')
  if (parts.length <= 2) return host
  return parts.slice(-2).join('.')
}

function readProfileFile(file) {
  const raw = JSON.parse(readFileSync(file, 'utf8'))
  if (!raw || typeof raw !== 'object') throw new Error('经验文件不是对象：' + file)
  if (typeof raw.id !== 'string' || raw.id === '') throw new Error('经验文件缺 id：' + file)
  if (typeof raw.domain !== 'string' || raw.domain === '') throw new Error('经验文件缺 domain：' + file)
  return raw
}

export class ProfileStore {
  constructor(dataDir) {
    this.dir = join(dataDir, 'profiles')
    this.corrupt = []
    mkdirSync(this.dir, { recursive: true })
  }

  /** 所有可用经验：内置 + 学到的，后者覆盖前者。 */
  all() {
    this.corrupt = []
    const map = new Map()
    for (const [dir, source] of [[BUILTIN_DIR, 'builtin'], [this.dir, 'learned']]) {
      let names = []
      try {
        names = readdirSync(dir).filter((n) => n.endsWith('.json'))
      } catch {
        continue
      }
      for (const name of names) {
        try {
          const p = readProfileFile(join(dir, name))
          map.set(p.id, { ...p, source: p.source ?? source, file: join(dir, name) })
        } catch (error) {
          // 坏文件不能静默跳过——那是「站点突然不见了」的唯一线索
          this.corrupt.push(name + '：' + String(error.message ?? error).slice(0, 120))
        }
      }
    }
    return [...map.values()]
  }

  get(id) {
    return this.all().find((p) => p.id === id)
  }

  /** 按 URL 找经验：先精确主机名，再退到域名尾两段。找不到返回 undefined。 */
  match(url) {
    const host = hostOf(url)
    const domainKey = domainKeyOf(url)
    if (!host) return undefined
    const all = this.all()
    return all.find((p) => String(p.domain).toLowerCase() === host)
      ?? all.find((p) => domainKeyOf('https://' + p.domain) === domainKey)
  }

  /** 存一份学到的经验。写临时文件再 rename，避免半截 JSON。 */
  save(profile) {
    if (!profile || typeof profile.id !== 'string' || !profile.id) throw new Error('经验缺 id')
    if (!profile.domain) throw new Error('经验缺 domain')
    const file = join(this.dir, profile.id + '.json')
    const payload = { ...profile, source: 'learned', learnedAt: profile.learnedAt ?? new Date().toISOString() }
    const tmp = file + '.tmp'
    writeFileSync(tmp, JSON.stringify(payload, null, 2) + '\n', 'utf8')
    renameSync(tmp, file)
    return file
  }
}
