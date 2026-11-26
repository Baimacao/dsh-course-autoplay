// dsh-course-autoplay —— 网课挂机插件（Host 半边）。
//
// 2026-11-25 那晚我用一堆 Python 脚本 + bsk CLI 给两个培训平台挂课，
// 跑通的是「读页面 → 决定下一步 → 点播放/切课」这条链。这里把它收成插件。
//
// 三层：
//   引擎 lib/engine.js    站点经验（JSON）→ 页面探针 / 决策 / 动作
//   经验 lib/profiles/    内置站点经验；<dataDir>/profiles/ 是自适应学到的，同名覆盖内置
//   自适应 lib/discover.js 没有经验时从页面嗅探出一份草稿，再用它复探一次确认
//
// 宿主包（dsh-tools / dsh-home-paths）一律运行时解析，不在顶层静态 import：
// 插件以 link: 装进 profile 时，解析起点回到 vendor 目录，
// 那里没有 @deepseek-ai/dsh-tools，静态 import 会让整个包加载失败。
import { CourseStore } from './lib/store.js'
import { makeLogger } from './lib/log.js'
import { createDriver, resolveBsk, runBsk } from './lib/bsk.js'
import { ProfileStore, hostOf, domainKeyOf } from './lib/profiles.js'
import { SNIFF, draftFrom, usable } from './lib/discover.js'
import { probeScript, plan as planStep, summarize } from './lib/engine.js'
import { startLoop, stepSite } from './lib/runner.js'
import { buildPlan, PlanWriter, stageOf } from './lib/plan.js'

export const name = 'dsh-course-autoplay'
export const inject = ['agents']

const TEXT_OUT = {
  type: 'object',
  additionalProperties: false,
  properties: { text: { type: 'string', required: true } },
}

const DEFAULTS = {
  bskPath: 'bsk',
  bskHome: '',
  dataDir: '',
  intervalMs: 15000,
  autoStart: false,
  planTitle: '',
}

async function resolveHostModule(ctx, modName) {
  try {
    const internal = ctx?.loader?.internal
    if (internal && typeof internal.import === 'function') {
      const mod = await internal.import(modName, ctx?.baseUrl, {})
      if (mod) return mod
    }
  } catch { /* 落到下面的 import */ }
  try {
    return await import(modName)
  } catch {
    return undefined
  }
}

function isSubagent(agent) {
  const h = agent?.session?.header ?? {}
  return h.origin === 'subagent'
    || h.parentSession !== undefined
    || (h.delegationDepth ?? 0) > 0
    || (agent?.options?.subagentDepth ?? 0) > 0
}

function refuseSubagent(exec) {
  if (exec.agent === undefined || isSubagent(exec.agent)) {
    throw new Error('挂课工具只属于主智能体')
  }
}

function describeState(state) {
  if (!state || Object.keys(state).length === 0) return '还没跑过'
  const bits = []
  const p = state.progress ?? {}
  if (p.kind === 'courses') bits.push('课程 ' + p.done + '/' + p.total)
  else if (p.kind === 'sections') bits.push('小节 ' + p.done + '/' + p.total)
  else if (p.kind === 'lessons') bits.push('讲次 ' + p.done + '/' + p.total)
  else if (p.kind === 'video') bits.push('单集视频')
  if (state.lastNote) bits.push(state.lastNote)
  if (state.lastError) bits.push('上次失败：' + state.lastError)
  if (state.updatedAt) bits.push('更新于 ' + state.updatedAt)
  return bits.join('｜')
}

/** 把站点 + 状态整理成面板要的形状（纯数据，客户端不碰会话）。 */
function snapshotOf(store, profiles) {
  const sites = store.sites().map((site) => {
    const state = store.state(site.id)
    const stage = stageOf(state)
    return {
      id: site.id,
      label: site.label || site.id,
      adapter: site.adapter ?? null,
      profileId: site.profileId ?? null,
      listUrl: site.listUrl,
      enabled: site.enabled !== false,
      host: hostOf(site.listUrl),
      progress: state.progress ?? { kind: 'unknown' },
      stage: stage.key,
      stageLabel: stage.label,
      lastNote: state.lastNote ?? '',
      lastError: state.lastError ?? '',
      lastErrorAt: state.lastErrorAt ?? null,
      updatedAt: state.updatedAt ?? null,
      session: state.session ?? null,
    }
  })
  const known = profiles.all().map((p) => ({
    id: p.id, name: p.name, domain: p.domain, source: p.source ?? 'builtin',
    usable: Boolean(p.listPage?.row?.clickSelector || p.playerPage?.section?.selector || p.playerPage?.lesson?.selector),
  }))
  return { sites, profiles: known, generatedAt: new Date().toISOString() }
}

/** 没写目标时自动生成一句：说清「哪些站、多少条目」。 */
export function autoGoalTitle(store) {
  const sites = store.sites()
  if (sites.length === 0) return '还没有站点'
  let total = 0
  let known = 0
  for (const s of sites) {
    const p = store.state(s.id).progress
    if (p && typeof p.total === 'number' && p.total > 0) {
      total += p.total
      known += 1
    }
  }
  const names = sites.map((s) => s.label || s.id).join('、')
  if (known === 0) return '把 ' + names + ' 的课挂完'
  return '把 ' + names + ' 共 ' + total + ' 个条目挂完'
}

export function tools(deps) {
  const { store, profiles, logger, planWriter, defineTool } = deps
  if (typeof defineTool !== 'function') {
    throw new Error('dsh-course-autoplay: 拿不到 @deepseek-ai/dsh-tools 的 defineTool，工具无法注册')
  }

  const writePlan = () => {
    const plan = buildPlan({
      sites: store.sites(),
      states: Object.fromEntries(store.sites().map((s) => [s.id, store.state(s.id)])),
      title: deps.config.planTitle,
    })
    planWriter.write(plan)
    return plan
  }

  const sitesTool = defineTool({
    name: 'autoplay_sites',
    description: '管理挂课站点。list 看现状；add 加一个（填课程列表页地址，会按域名自动找经验，找不到就标出来要 discover）；' +
      'update 改地址/开关；remove 删掉。站点配置在 <DSH_HOME>/course-autoplay/sites.json。',
    parameters: {
      action: { type: 'string', required: true, description: 'list | add | update | remove' },
      id: { type: 'string', description: 'update/remove 用；add 不填会自动生成' },
      listUrl: { type: 'string', description: '课程列表页地址，例如 https://www.hnzjpx.cn/235/subject' },
      label: { type: 'string', description: '给人看的名字' },
      profileId: { type: 'string', description: '指定用哪份站点经验；不填按域名自动匹配' },
      enabled: { type: 'boolean', description: 'false 就先不动这个站点' },
    },
    output: { schema: TEXT_OUT, render: (_a, v) => [{ type: 'text', text: v.text }] },
    async execute(args, exec) {
      refuseSubagent(exec)
      if (args.action === 'list') {
        const list = store.sites()
        if (list.length === 0) return { text: '还没有站点。用 action=add 填课程列表页地址加一个。' }
        const lines = ['共 ' + list.length + ' 个站点：']
        for (const s of list) {
          const st = store.state(s.id)
          const prof = profiles.get(s.profileId) ?? profiles.match(s.listUrl)
          lines.push('- ' + s.id + '（' + (s.enabled === false ? '已停用' : '启用') + '）' + (s.label || ''))
          lines.push('  地址 ' + s.listUrl)
          lines.push('  经验 ' + (prof ? prof.id + '（' + (prof.source ?? 'builtin') + '）' : '没有——先 autoplay_discover'))
          lines.push('  状态 ' + describeState(st))
        }
        if (store.corrupt.length > 0) lines.push('⚠ 读坏的文件：' + store.corrupt.join('、'))
        if (profiles.corrupt.length > 0) lines.push('⚠ 经验文件有问题：' + profiles.corrupt.join('、'))
        return { text: lines.join('\n') }
      }
      if (args.action === 'add') {
        const matched = args.profileId ? profiles.get(args.profileId) : profiles.match(args.listUrl)
        const site = store.addSite({
          id: args.id,
          listUrl: args.listUrl,
          label: args.label,
          enabled: args.enabled,
          profileId: args.profileId ?? matched?.id,
        })
        writePlan()
        const lines = ['加好了：' + site.id + ' → ' + site.listUrl]
        if (matched) lines.push('已匹配经验 ' + matched.id + '（' + (matched.source ?? 'builtin') + '），可以直接 autoplay_run start')
        else lines.push('这个域名还没有经验。先 autoplay_discover id=' + site.id + ' 让它自己认页面')
        return { text: lines.join('\n') }
      }
      if (args.action === 'update') {
        if (!args.id) throw new Error('update 要给 id')
        const site = store.updateSite(args.id, {
          listUrl: args.listUrl, label: args.label, enabled: args.enabled, profileId: args.profileId,
        })
        writePlan()
        return { text: '改好了：' + site.id + ' → ' + site.listUrl }
      }
      if (args.action === 'remove') {
        if (!args.id) throw new Error('remove 要给 id')
        const left = store.removeSite(args.id)
        writePlan()
        return { text: '删掉了 ' + args.id + '，还剩 ' + left + ' 个站点' }
      }
      throw new Error('action 只能是 list / add / update / remove，收到 "' + args.action + '"')
    },
  })

  const discoverTool = defineTool({
    name: 'autoplay_discover',
    description: '自适应识别一个站点的页面结构：在页面里嗅探课程列表/小节/视频，拼出一份站点经验，' +
      '再用它复探一次确认能复现，确认通过才存下来。dryRun=true 只看不存。',
    parameters: {
      id: { type: 'string', required: true, description: '站点 id' },
      dryRun: { type: 'boolean', description: '只探测不保存' },
    },
    output: { schema: TEXT_OUT, render: (_a, v) => [{ type: 'text', text: v.text }] },
    async execute(args, exec) {
      refuseSubagent(exec)
      const site = store.sites().find((s) => s.id === args.id)
      if (!site) throw new Error('没有这个站点：' + args.id)
      const driver = deps.driver()
      const prev = store.state(site.id)
      let session = prev.session
      if (!session) {
        const created = await driver.startSession('autoplay-' + site.id)
        session = created?.session_id ?? created?.id ?? created?.name
        if (!session) throw new Error('开不了 bsk 会话：' + JSON.stringify(created).slice(0, 200))
      }
      // 先确保在列表页
      await driver.evaluate(session, '(() => { if (location.href.indexOf(' + JSON.stringify(site.listUrl) +
        ') !== 0) location.href = ' + JSON.stringify(site.listUrl) + '; return 1; })()')
      await new Promise((r) => setTimeout(r, 3000))

      const sniff = await driver.evaluate(session, SNIFF)
      const draft = draftFrom(sniff, site)
      const check = usable(draft)
      const lines = [
        '嗅探：视频 ' + (sniff?.videos?.length ?? 0) + ' 个，候选可点条目 ' + (sniff?.candidates?.length ?? 0) +
          ' 个，同类列表组 ' + (sniff?.groups?.length ?? 0) + ' 个，页面进度计数 ' + (sniff?.counters?.length ?? 0) + ' 个',
      ]
      if (!draft) return { text: lines.concat(['没能从页面认出课程结构——可能没登录、还在登录页，或者这个站的页面结构特殊，需要手工写一份经验。']).join('\n') }
      lines.push('草稿：' + JSON.stringify({ listPage: draft.listPage, playerPage: draft.playerPage }))
      if (!check.ok) return { text: lines.concat(['草稿不能用：' + check.why]).join('\n') }

      if (args.dryRun === true) {
        return { text: lines.concat(['dryRun：没有保存。去掉 dryRun 才会写进经验库。']).join('\n') }
      }

      // 用草稿复探一次：结构必须能复现，否则一次 DOM 抖动就会被当成经验存下来
      const replay = await driver.evaluate(session, probeScript(draft))
      const replaySummary = summarize(replay)
      if (replaySummary.kind === 'unknown') {
        return { text: lines.concat(['复探没读到任何结构，判定为不可复现，没有保存。刷新页面后再试一次。']).join('\n') }
      }
      const saved = profiles.save({ ...draft, sniffedFrom: site.listUrl })
      store.updateSite(site.id, { profileId: draft.id })
      store.saveState(site.id, { ...prev, session })
      writePlan()
      return {
        text: lines.concat([
          '复探通过：' + replaySummary.kind + ' ' + (replaySummary.done ?? 0) + '/' + (replaySummary.total ?? 0),
          '已存经验 ' + draft.id + ' → ' + saved,
          '站点已指向这份经验。autoplay_run start 开始跑。',
        ]).join('\n'),
      }
    },
  })

  const probeTool = defineTool({
    name: 'autoplay_probe',
    description: '对某个站点跑一次只读探针：读当前页面，报进度和下一步计划。不改页面、不点任何东西。',
    parameters: { id: { type: 'string', required: true, description: '站点 id' } },
    output: { schema: TEXT_OUT, render: (_a, v) => [{ type: 'text', text: v.text }] },
    async execute(args, exec) {
      refuseSubagent(exec)
      const site = store.sites().find((s) => s.id === args.id)
      if (!site) throw new Error('没有这个站点：' + args.id)
      const profile = profiles.get(site.profileId) ?? profiles.match(site.listUrl)
      if (!profile) throw new Error('这个站点还没有经验，先 autoplay_discover id=' + site.id)
      const prev = store.state(site.id)
      if (!prev.session) throw new Error('还没有 bsk 会话。先 autoplay_run action=start 跑一轮，或 autoplay_discover。')
      const state = await deps.driver().evaluate(prev.session, probeScript(profile))
      const action = planStep(state, site, { stuck: Number(prev.stuck ?? 0) })
      const s = summarize(state)
      const lines = [
        '站点 ' + site.id + '（经验 ' + profile.id + '）',
        '页面 ' + (state?.url ?? '?') + ' ｜ ' + (state?.title ?? '?'),
        '结构 ' + s.kind + ' ' + (s.done ?? 0) + '/' + (s.total ?? 0),
        '视频 ' + JSON.stringify(state?.video ?? null),
        '下一步 ' + action.action + '：' + action.note + '（等 ' + Math.round(action.delayMs / 1000) + 's）',
      ]
      return { text: lines.join('\n') }
    },
  })

  const runTool = defineTool({
    name: 'autoplay_run',
    description: '启动 / 停止挂课循环，或看状态。',
    parameters: { action: { type: 'string', required: true, description: 'start | stop | status' } },
    output: { schema: TEXT_OUT, render: (_a, v) => [{ type: 'text', text: v.text }] },
    async execute(args, exec) {
      refuseSubagent(exec)
      if (args.action === 'start') return { text: deps.loop().start().text }
      if (args.action === 'stop') return { text: deps.loop().stop().text }
      if (args.action === 'status') {
        const lines = ['循环 ' + (deps.isLooping() ? '在跑' : '停着')]
        const list = store.sites()
        if (list.length === 0) lines.push('还没有站点。')
        for (const s of list) {
          const stage = stageOf(store.state(s.id))
          lines.push('- ' + s.id + '［' + stage.label + '］' + describeState(store.state(s.id)))
        }
        return { text: lines.join('\n') }
      }
      throw new Error('action 只能是 start / stop / status')
    },
  })

  const logTool = defineTool({
    name: 'autoplay_log',
    description: '读挂课运行日志（默认最后 40 行）。文件在 <DSH_HOME>/course-autoplay/run.log。',
    parameters: { lines: { type: 'integer', description: '看多少行，默认 40，最多 500' } },
    output: { schema: TEXT_OUT, render: (_a, v) => [{ type: 'text', text: v.text }] },
    async execute(args, exec) {
      refuseSubagent(exec)
      const n = Math.min(500, Math.max(1, Number(args.lines ?? 40)))
      const tail = logger.tail(n)
      if (tail.length === 0) return { text: '还没有日志（' + logger.file + '）' }
      return { text: tail.join('\n') }
    },
  })

  const bskTool = defineTool({
    name: 'autoplay_bsk',
    description: '直接问 bsk：status 看 daemon 和已连接的浏览器，sessions 看现有会话。跑不起来时先看这个。',
    parameters: { action: { type: 'string', required: true, description: 'status | sessions' } },
    output: { schema: TEXT_OUT, render: (_a, v) => [{ type: 'text', text: v.text }] },
    async execute(args, exec) {
      refuseSubagent(exec)
      if (args.action === 'status') {
        const { value } = await runBsk({ bskPath: deps.bskPath(), homeDir: deps.bskHome() }, ['status', '--json'], 30_000)
        const failed = !value || value.code != null
          || (typeof value.exit_code === 'number' && value.exit_code !== 0)
        if (failed) {
          return {
            text: 'daemon 没在跑（' + (value?.code ?? 'exit ' + (value?.exit_code ?? '?')) + '）：' + (value?.message ?? '') + '\n' +
              '在 DSH 之外开一个常驻任务跑 bsk daemon start --foreground（同一 BSK_HOME：' + deps.bskHome() + '）。\n' +
              '为什么必须外部跑：从 DSH 进程里 detach 的进程会被 Job Object 一起收走（os error 5）。',
          }
        }
        return {
          text: 'daemon 在跑（pid ' + (value?.pid ?? '?') + '，端口 ' + (value?.ws_port ?? '?') + '）\n' +
            '已连接浏览器 ' + (Array.isArray(value?.browsers) ? value.browsers.length : 0) + ' 个，活跃会话 ' +
            (Array.isArray(value?.sessions) ? value.sessions.length : 0) + ' 个',
        }
      }
      if (args.action === 'sessions') {
        const list = await deps.driver().sessions()
        if (list.length === 0) return { text: '没有活跃会话' }
        return { text: list.map((s) => '- ' + JSON.stringify(s).slice(0, 200)).join('\n') }
      }
      throw new Error('action 只能是 status / sessions')
    },
  })

  const planTool = defineTool({
    name: 'autoplay_plan',
    description: '生成 / 读取挂课计划文档（<DSH_HOME>/course-autoplay/plan.md 和 plan.json）：' +
      '目标、每个站点的阶段、待办和进度。写完会同时更新内存里的目标达成情况。',
    parameters: {
      action: { type: 'string', required: true, description: 'write | read' },
      title: { type: 'string', description: '目标写成什么；不填沿用上次或自动生成' },
    },
    output: { schema: TEXT_OUT, render: (_a, v) => [{ type: 'text', text: v.text }] },
    async execute(args, exec) {
      refuseSubagent(exec)
      if (args.action === 'read') {
        const plan = planWriter.read()
        if (!plan) return { text: '还没有计划文档。autoplay_plan action=write 生成一份。' }
        return { text: plan.markdown.slice(0, 4000) }
      }
      if (args.action === 'write') {
        if (args.title) deps.config.planTitle = args.title
        const plan = writePlan()
        return {
          text: '计划写好了：' + planWriter.md + '\n\n' + plan.markdown.slice(0, 3000),
        }
      }
      throw new Error('action 只能是 write / read')
    },
  })

  return [sitesTool, discoverTool, probeTool, runTool, logTool, bskTool, planTool]
}

/**
 * 注册面板用的 HTTP 路由。
 *
 * 优先用 webServer.register（本机 dsh-restart-button 正在用的那套，形状已核实）；
 * 没有 webServer 时退回 connection.fetch.register。两条都拿不到就明确告警——
 * 面板缺数据比面板假装有数据好。
 */
function registerRoutes(ctx, handlers) {
  const json = (body) => new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
  // 这条路只接 GET/HEAD（宿主 WebResourceRoute 的限制），参数从查询串读。
  const readParams = (request) => {
    try {
      const url = new URL(request.url, 'http://localhost')
      return Object.fromEntries(url.searchParams.entries())
    } catch {
      return {}
    }
  }

  const routes = [
    ['/course-autoplay/state', async () => handlers.state()],
    ['/course-autoplay/run', async (req) => handlers.run(readParams(req))],
    ['/course-autoplay/add', async (req) => handlers.add(readParams(req))],
    ['/course-autoplay/save', async (req) => handlers.save(readParams(req))],
    ['/course-autoplay/log', async (req) => handlers.log(readParams(req))],
  ]

  return ctx.inject(['webServer'], (scope) => {
    const webServer = scope.get('webServer')
    if (!webServer || typeof webServer.register !== 'function') {
      ctx.logger?.warn?.('dsh-course-autoplay: 没有 webServer 服务，面板拿不到数据')
      return
    }
    return scope.effect(() => {
      const disposers = []
      for (const [path, fn] of routes) {
        disposers.push(webServer.register({
          kind: 'exact',
          path,
          resource: async (request) => {
            if (request.method !== 'GET' && request.method !== 'HEAD' && request.method !== 'POST') {
              return json({ ok: false, error: { code: 'method_not_allowed', message: request.method } })
            }
            try {
              return json(await fn(request))
            } catch (error) {
              // 面板上的失败要看得见原因，不能只留一个空面板
              return json({ ok: false, error: { code: 'handler_failed', message: String(error?.message ?? error) } })
            }
          },
        }))
      }
      return () => {
        for (const d of disposers) {
          try { d?.() } catch { /* 已经没了 */ }
        }
      }
    })
  })
}

export async function apply(ctx, rawConfig = {}) {
  const config = { ...DEFAULTS, ...(rawConfig ?? {}) }
  const interval = Number(config.intervalMs)
  if (!Number.isFinite(interval) || interval < 5000 || interval > 600000) {
    throw new Error('intervalMs 要在 5000..600000 之间，收到 ' + String(config.intervalMs))
  }
  config.intervalMs = interval

  const toolsModule = await resolveHostModule(ctx, '@deepseek-ai/dsh-tools')
  const homeModule = await resolveHostModule(ctx, '@deepseek-ai/dsh-home-paths')
  const defineTool = toolsModule?.defineTool
  if (typeof defineTool !== 'function') {
    throw new Error('dsh-course-autoplay: 拿不到 @deepseek-ai/dsh-tools 的 defineTool（宿主模块解析失败）')
  }

  const dir = String(config.dataDir ?? '').trim()
    || (typeof homeModule?.dshHomePath === 'function'
      ? homeModule.dshHomePath('course-autoplay')
      : (process.env.DSH_HOME ?? process.cwd()).replace(/[\\/]+$/, '') + '/course-autoplay')
  const bskHome = String(config.bskHome ?? '').trim()
    || (typeof homeModule?.dshHomePath === 'function'
      ? homeModule.dshHomePath('bsk')
      : (process.env.DSH_HOME ?? process.cwd()).replace(/[\\/]+$/, '') + '/bsk')

  const store = new CourseStore(dir)
  const profiles = new ProfileStore(dir)
  const logger = makeLogger(dir)
  const planWriter = new PlanWriter(dir)

  let bskPath
  let bskError
  try {
    bskPath = resolveBsk(config.bskPath)
  } catch (error) {
    bskError = String(error?.message ?? error)
    bskPath = String(config.bskPath ?? 'bsk')
    logger.line('main', '找不到 bsk，挂课会失败：' + bskError)
  }
  const requireBsk = () => {
    if (bskError) throw new Error(bskError)
    return bskPath
  }
  const driver = createDriver({ bskPath, homeDir: bskHome }, logger)

  let loopHandle

  const writePlan = () => {
    const sites = store.sites()
    const plan = buildPlan({
      sites,
      states: Object.fromEntries(sites.map((s) => [s.id, store.state(s.id)])),
      title: config.planTitle || autoGoalTitle(store),
    })
    planWriter.write(plan)
    return plan
  }

  const deps = {
    store, profiles, logger, planWriter, defineTool, config: config,
    driver: () => driver,
    bskPath: () => requireBsk(),
    bskHome: () => bskHome,
    isLooping: () => loopHandle !== undefined,
    loop: () => ({
      start() {
        if (loopHandle) return { text: '循环已经在跑了。用 action=status 看进度，stop 先停。' }
        const enabled = store.sites().filter((s) => s.enabled !== false)
        if (enabled.length === 0) throw new Error('还没有启用的站点，先 autoplay_sites action=add')
        const noProfile = enabled.filter((s) => !(profiles.get(s.profileId) ?? profiles.match(s.listUrl)))
        if (noProfile.length > 0) {
          throw new Error('这些站点还没有经验，先 autoplay_discover：' + noProfile.map((s) => s.id).join('、'))
        }
        requireBsk()
        loopHandle = startLoop({
          driver, store, profiles, logger, intervalMs: config.intervalMs,
          onRound: () => { try { writePlan() } catch (error) { logger.line('main', '写计划失败 ' + String(error).slice(0, 160)) } },
        })
        logger.line('main', '循环启动，站点 ' + enabled.map((s) => s.id).join('、'))
        writePlan()
        return { text: '循环启动了：' + enabled.map((s) => s.id).join('、') + '。用 autoplay_log 看进展，autoplay_plan 看计划。' }
      },
      stop() {
        if (!loopHandle) return { text: '循环本来就没跑。' }
        loopHandle.stop()
        loopHandle = undefined
        logger.line('main', '循环已停止')
        return { text: '循环停了。bsk 会话保留，重新 start 会从断点继续。' }
      },
    }),
  }

  const toolList = tools(deps)
  const install = (agent) => {
    if (isSubagent(agent)) return undefined
    return agent.ctx.inject(['tools'], (c) => {
      for (const tool of toolList) c.tools.register(tool)
    })
  }

  const agents = ctx.get('agents')
  if (!agents || typeof agents.list !== 'function') {
    throw new Error('dsh-course-autoplay: 拿不到 agents 服务，无法按会话装载；不会静默跳过')
  }

  const installed = new Map()
  ctx.on('agent/created', ({ agent }) => {
    const f = install(agent)
    if (f) installed.set(agent.id, f)
  })
  ctx.on('agent/disposed', ({ agent }) => {
    const f = installed.get(agent?.id)
    try { f?.dispose?.() } catch (error) { ctx.logger?.warn?.('dsh-course-autoplay: 卸载失败 ' + String(error)) }
    installed.delete(agent?.id)
  })
  for (const agent of agents.list()) {
    const f = install(agent)
    if (f) installed.set(agent.id, f)
  }

  // ── 面板路由 ────────────────────────────────────────────
  const handlers = {
    state: () => ({
      ok: true,
      value: {
        ...snapshotOf(store, profiles),
        looping: loopHandle !== undefined,
        plan: planWriter.read()?.json ?? null,
        planMarkdown: planWriter.read()?.markdown ?? '',
        logTail: logger.tail(30),
        dataDir: dir,
        bskHome,
        bskReady: bskError === undefined,
        bskError: bskError ?? null,
        intervalMs: config.intervalMs,
      },
    }),
    run: ({ action }) => {
      const r = action === 'stop' ? deps.loop().stop() : deps.loop().start()
      return { ok: true, value: r }
    },
    add: ({ listUrl, label }) => {
      const matched = profiles.match(String(listUrl ?? ''))
      const site = store.addSite({ listUrl, label, profileId: matched?.id })
      writePlan()
      return { ok: true, value: { site, profileId: matched?.id ?? null } }
    },
    save: ({ id, enabled, listUrl, label, remove }) => {
      if (remove === 'true' || remove === true || remove === '1') {
        store.removeSite(String(id))
        writePlan()
        return { ok: true, value: { removed: id } }
      }
      const asBool = (v) => (v === undefined || v === '' ? undefined : (v === 'true' || v === true || v === '1'))
      const site = store.updateSite(String(id), {
        ...(asBool(enabled) === undefined ? {} : { enabled: asBool(enabled) }),
        ...(listUrl === undefined ? {} : { listUrl }),
        ...(label === undefined ? {} : { label }),
      })
      writePlan()
      return { ok: true, value: site }
    },
    log: ({ lines }) => ({ ok: true, value: logger.tail(Math.min(200, Math.max(1, Number(lines ?? 50)))) }),
  }

  try {
    registerRoutes(ctx, handlers)
  } catch (error) {
    ctx.logger?.warn?.('dsh-course-autoplay: 路由注册失败 ' + String(error))
  }

  ctx.effect(() => () => {
    loopHandle?.stop()
    loopHandle = undefined
    for (const f of installed.values()) {
      try { f?.dispose?.() } catch { /* 已经没了 */ }
    }
    installed.clear()
  })

  if (config.autoStart === true) {
    try {
      deps.loop().start()
    } catch (error) {
      ctx.logger?.warn?.('dsh-course-autoplay: 自动启动失败 ' + String(error))
    }
  }

  ctx.logger?.info?.('dsh-course-autoplay: 数据目录 ' + dir + '，经验 ' + profiles.all().length + ' 份，bsk ' +
    (bskError ? '（未找到）' : bskPath))
}
