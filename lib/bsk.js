// bsk CLI 的薄封装。
//
// 为什么走 CLI 而不直接连 daemon 的 websocket：CLI 是 bsk 自己的公开入口，
// 参数、JSON 输出和错误码都由上游维护，我只需要一个稳定的调用面。
//
// 两条实测事实决定了这里的写法：
//  1) 从 DSH 进程里拉起的子进程活在 DSH 的 Job Object 里，bsk 的独立守护进程
//     起不来（os error 5）。daemon 必须由外部常驻任务跑，本插件只当客户端，
//     所以每条命令都带 BSK_AUTO_START=0，不企图自己拉起 daemon。
//  2) 参数随版本变：0.4.x 的 evaluate 没有 --unverified，0.5.x 有；共享标签页
//     上的动作要 --context。这里按「先按新版本试，遇到参数不认就退回」处理，
//     并把退回来的那条记下来，别让版本差异变成难查的怪毛病。
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const DEFAULT_TIMEOUT_MS = 60_000

/** 在 PATH 上找一个可执行文件名（Windows 会尝试 .exe/.cmd/.bat）。 */
export function lookupPath(name) {
  const dirs = String(process.env.PATH ?? '').split(process.platform === 'win32' ? ';' : ':').filter(Boolean)
  const exts = process.platform === 'win32'
    ? (name.toLowerCase().endsWith('.exe') ? [''] : ['', '.exe', '.cmd', '.bat'])
    : ['']
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = join(dir, name + ext)
      if (existsSync(candidate)) return candidate
    }
  }
  return ''
}

/**
 * 找 bsk 可执行文件。配置里写了就用配置的（裸名字按 PATH 解析）。
 * 找不到就抛错——挂课跑不起来时，报错要指向真正的原因，而不是等到 spawn 才炸。
 */
export function resolveBsk(configPath) {
  const explicit = String(configPath ?? '').trim()
  if (explicit) {
    if (/[\\/]/.test(explicit)) {
      if (!existsSync(explicit)) throw new Error('配置里的 bskPath 不存在：' + explicit)
      return explicit
    }
    const onPath = lookupPath(explicit)
    if (onPath) return onPath
    throw new Error('配置里的 bskPath 不在 PATH 上：' + explicit)
  }
  const found = lookupPath(process.platform === 'win32' ? 'bsk.exe' : 'bsk')
  if (found) return found
  throw new Error('找不到 bsk CLI。装好 BrowserSkill 并把 bsk 放进 PATH，或在插件配置里写 bskPath。')
}

/**
 * 跑一条 bsk 命令，返回 { code, value, stderr }。
 * value 是解析后的 JSON；拿不到 JSON 一律抛错，不返回 undefined 让上层猜。
 */
export function runBsk(deps, args, timeoutMs = DEFAULT_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, BSK_HOME: deps.homeDir, BSK_AUTO_START: '0' }
    let child
    try {
      child = spawn(deps.bskPath, args, { env, windowsHide: true })
    } catch (error) {
      reject(new Error('启动 bsk 失败（' + deps.bskPath + '）：' + String(error)))
      return
    }
    let out = ''
    let err = ''
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try { child.kill() } catch { /* 已经退出 */ }
      reject(new Error('bsk 命令超时（' + timeoutMs + 'ms）：' + args.join(' ')))
    }, timeoutMs)
    child.stdout?.on('data', (chunk) => { out += String(chunk) })
    child.stderr?.on('data', (chunk) => { err += String(chunk) })
    child.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(new Error('bsk 执行出错（' + deps.bskPath + '）：' + String(error)))
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      const text = out.trim()
      let parsed
      if (text) {
        try { parsed = JSON.parse(text) } catch { parsed = undefined }
      }
      if (parsed === undefined) {
        reject(new Error('bsk 没有返回 JSON（退出码 ' + code + '）：' + (text || err).slice(0, 400)))
        return
      }
      resolve({ code, value: parsed, stderr: err })
    })
  })
}

/**
 * bsk 的失败回执：{ code, message, hint, exit_code }。
 * 注意 code 可能是 null（daemon 没起时就是 null + exit_code 2），
 * 只判 code 是不是字符串会把失败当成功，报出「开会话没返回 session id」这种误导性错误。
 */
function failureOf(value) {
  if (!value || typeof value !== 'object') return undefined
  if (value.code != null) return value
  if (typeof value.exit_code === 'number' && value.exit_code !== 0) return value
  if (typeof value.message === 'string' && value.ok === undefined && value.value === undefined) return value
  return undefined
}

/**
 * 建一个已绑好参数的执行器，供适配器调用。
 * @param {{ bskPath: string, homeDir: string }} deps
 * @param {{ line: (tag: string, msg: string) => void }} [log]
 * @param {{ invoke?: Function }} [options] 测试可注入 invoke，生产用 runBsk
 */
export function createDriver(deps, log, options = {}) {
  const invoke = options.invoke ?? runBsk
  // 版本能力，按需探测一次就记住
  const caps = { unverified: undefined, context: undefined }

  const call = async (args, timeoutMs) => {
    const { value } = await invoke(deps, args, timeoutMs)
    const failure = failureOf(value)
    if (failure) {
      // code 可能是 null（daemon 没起就是这么回的），这时报 exit_code 更有用
      const label = failure.code ?? ('exit ' + (failure.exit_code ?? '?'))
      const error = new Error('bsk ' + args[0] + ' 失败（' + label + '）：' + (failure.message ?? ''))
      error.code = failure.code
      error.hint = failure.hint
      throw error
    }
    return value
  }

  /** 参数不被这个版本的 bsk 认。 */
  const isUnknownArg = (error) => error?.code === 'invalid_params'
    && /unexpected argument|unrecognized|unknown argument/i.test(String(error.message) + String(error.hint ?? ''))

  return {
    caps,

    /** 同步出控制上下文，用于共享标签页上的动作。拿不到就返回空串。 */
    async sync(session, tabId) {
      const args = ['cooperate', 'sync', '--session', session, '--json', '--max-tokens', '150']
      if (tabId !== undefined && tabId !== null) args.push('--tab-id', String(tabId))
      const value = await call(args)
      return typeof value?.context_id === 'string' ? value.context_id : ''
    },

    /**
     * 在页面里求值，返回 JS 的值本身。
     * 版本差异（--unverified / --context）在这里消化，上层看不到。
     */
    async evaluate(session, expression, { tabId } = {}) {
      const build = (withUnverified, context) => {
        const args = ['evaluate', expression, '--session', session, '--json', '--timeout', '30s']
        if (tabId !== undefined && tabId !== null) args.push('--tab-id', String(tabId))
        if (context) args.push('--context', context)
        if (withUnverified) args.push('--unverified')
        return args
      }

      let withUnverified = caps.unverified !== false
      let context = caps.context === true ? await this.sync(session, tabId) : ''
      let value
      for (let attempt = 0; attempt < 4; attempt += 1) {
        try {
          value = await call(build(withUnverified, context), 45_000)
          if (withUnverified) caps.unverified = true
          break
        } catch (error) {
          if (attempt === 0 && withUnverified && isUnknownArg(error)) {
            // 这个版本的 bsk 没有 --unverified：记一次，之后不再试
            caps.unverified = false
            log?.line('bsk', '这个 bsk 版本没有 --unverified，改用不带它的求值')
            withUnverified = false
            continue
          }
          if (attempt === 0 && !context && /context/i.test(String(error.message))) {
            caps.context = true
            context = await this.sync(session, tabId)
            log?.line('bsk', 'evaluate 需要 --context，已先 sync 取得')
            continue
          }
          throw error
        }
      }
      if (value === undefined) throw new Error('evaluate 重试到上限仍未拿到结果')
      if (value && typeof value === 'object' && value.ok === false) {
        throw new Error('页面求值失败：' + JSON.stringify(value.error ?? value).slice(0, 300))
      }
      // bsk 的 evaluate 回执是 { ok: true, value }；没包一层时直接就是值。
      // 只在「确实是回执」时拆一层，避免把适配器自己的 { value: x } 拆坏。
      if (value && typeof value === 'object' && value.ok === true
        && Object.prototype.hasOwnProperty.call(value, 'value')) return value.value
      return value
    },

    /** 当前有哪些 bsk 会话。 */
    async sessions() {
      const value = await call(['session', 'list', '--json'])
      if (Array.isArray(value)) return value
      if (value && Array.isArray(value.sessions)) return value.sessions
      return []
    },

    /** 开一个会话（需要浏览器扩展已连接）。 */
    async startSession(name) {
      const args = ['session', 'start', '--json']
      if (name) args.push('--name', String(name))
      return call(args, 120_000)
    },

    /** 页面跳转。 */
    async navigate(session, url) {
      return call(['navigate', url, '--session', session, '--json'], 90_000)
    },

    log,
  }
}
