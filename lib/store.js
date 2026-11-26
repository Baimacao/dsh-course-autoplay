// 站点配置和每站运行状态，落在 <数据目录>/sites.json 与 state.json。
// 写文件一律「写临时文件再 rename」：半截 JSON 会让下次启动直接读不出来。
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 读 JSON。返回值带 broken 标记：文件不存在和「文件坏了」必须分开，
 * 否则坏掉的配置会被当成空配置，表现成「站点突然全没了」而没有任何提示。
 */
function readJson(file, fallback) {
  if (!existsSync(file)) return { value: fallback, broken: false }
  try {
    return { value: JSON.parse(readFileSync(file, 'utf8')), broken: false }
  } catch (error) {
    return { value: fallback, broken: true, error: String(error) }
  }
}

function writeJson(file, value) {
  const tmp = file + '.tmp'
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8')
  renameSync(tmp, file)
}

export class CourseStore {
  constructor(dir) {
    this.dir = dir
    this.sitesFile = join(dir, 'sites.json')
    this.stateFile = join(dir, 'state.json')
    this.corrupt = []
    mkdirSync(dir, { recursive: true })
  }

  /** 站点列表。读坏的文件会被记录到 corrupt，不当成空配置悄悄过去。 */
  sites() {
    this.corrupt = []
    const read = readJson(this.sitesFile, { sites: [] })
    if (read.broken) {
      this.corrupt.push('sites.json')
      return []
    }
    const raw = read.value
    if (!raw || !Array.isArray(raw.sites)) {
      this.corrupt.push('sites.json')
      return []
    }
    return raw.sites.filter((s) => s && typeof s.id === 'string')
  }

  saveSites(sites) {
    writeJson(this.sitesFile, { sites })
  }

  addSite(input) {
    const listUrl = String(input.listUrl ?? '').trim()
    if (!/^https?:\/\//i.test(listUrl)) throw new Error('listUrl 要是一个 http(s) 地址')
    const sites = this.sites()
    const id = String(input.id ?? '').trim() || idFromUrl(listUrl)
    if (sites.some((s) => s.id === id)) throw new Error('已经有同 id 的站点：' + id)
    const site = {
      id,
      listUrl,
      label: String(input.label ?? '').trim() || hostLabel(listUrl),
      enabled: input.enabled === undefined ? true : Boolean(input.enabled),
      profileId: input.profileId ? String(input.profileId) : undefined,
      createdAt: new Date().toISOString(),
    }
    sites.push(site)
    this.saveSites(sites)
    return site
  }

  updateSite(id, patch) {
    const sites = this.sites()
    const site = sites.find((s) => s.id === id)
    if (!site) throw new Error('没有这个站点：' + id)
    if (patch.listUrl !== undefined) {
      if (!/^https?:\/\//i.test(String(patch.listUrl))) throw new Error('listUrl 要是一个 http(s) 地址')
      site.listUrl = String(patch.listUrl).trim()
    }
    if (patch.label !== undefined) site.label = String(patch.label)
    if (patch.enabled !== undefined) site.enabled = Boolean(patch.enabled)
    if (patch.profileId !== undefined) site.profileId = patch.profileId ? String(patch.profileId) : undefined
    this.saveSites(sites)
    return site
  }

  removeSite(id) {
    const sites = this.sites()
    const next = sites.filter((s) => s.id !== id)
    if (next.length === sites.length) throw new Error('没有这个站点：' + id)
    this.saveSites(next)
    const state = this.allState()
    if (state[id] !== undefined) {
      delete state[id]
      writeJson(this.stateFile, state)
    }
    return next.length
  }

  allState() {
    const read = readJson(this.stateFile, {})
    if (read.broken) {
      // 状态坏了不致命（下次会重建），但要说出来，不能装作没发生
      this.corrupt.push('state.json')
      return {}
    }
    const raw = read.value
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  }

  state(id) {
    const s = this.allState()[id]
    return s && typeof s === 'object' ? s : {}
  }

  saveState(id, value) {
    const all = this.allState()
    all[id] = value
    writeJson(this.stateFile, all)
  }
}

/** 从地址推一个稳定、可读的 id（同名站点加后缀会冲突，所以带路径特征）。 */
export function idFromUrl(url) {
  try {
    const u = new URL(String(url))
    const host = u.host.replace(/^www\./, '')
    const seg = u.pathname.split('/').filter(Boolean)[0] ?? ''
    return (host + (seg ? '-' + seg : '')).replace(/[^a-z0-9]+/gi, '-').toLowerCase()
  } catch {
    return 'site-' + Date.now().toString(36)
  }
}

function hostLabel(url) {
  try {
    return new URL(String(url)).host
  } catch {
    return String(url).slice(0, 30)
  }
}
