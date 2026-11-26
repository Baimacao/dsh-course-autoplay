// 主循环：每轮对每个启用站点做一次「读页面 → 决定 → 动手 → 记账」。
//
// 站点之间串行，同一时刻只驱动一个页面；一轮结束后按各站要求的最短间隔排下一轮。
//
// 为什么全在一个进程里：bsk 命令本身就是子进程，再套一层只会让「谁还活着」更难判断。
// 异常一律记进日志并留在状态里，绝不让一次失败静悄悄地把循环停掉。
import { probeScript, plan as planStep, apply as applyStep, summarize } from './engine.js'

/** 一次单站推进。失败抛错，由调用方记日志。 */
export async function stepSite(driver, site, profile, prevState, log) {
  const stuck = Number(prevState?.stuck ?? 0)

  let session = prevState?.session
  if (!session) {
    const created = await driver.startSession('autoplay-' + site.id)
    session = created?.session_id ?? created?.id ?? created?.name
    if (!session) throw new Error('bsk 开会话没返回 session id：' + JSON.stringify(created).slice(0, 200))
    log?.line(site.id, '开会话 ' + session)
  }

  const probe = await driver.evaluate(session, probeScript(profile))
  if (!probe || typeof probe !== 'object') {
    throw new Error('页面探针没返回对象：' + JSON.stringify(probe).slice(0, 200))
  }

  const action = planStep(probe, site, { stuck })
  const videoOk = Boolean(probe.video && probe.video.d > 0) || probe.mode === 'list'
  const nextStuck = videoOk ? 0 : stuck + 1

  let applied = null
  try {
    applied = await applyStep(driver, session, action, site, profile)
  } catch (error) {
    log?.line(site.id, '动作失败 ' + action.action + '：' + String(error).slice(0, 200))
  }

  const next = {
    session,
    stuck: nextStuck,
    lastAction: action.action,
    lastNote: action.note,
    lastUrl: probe.url,
    lastMode: probe.mode ?? 'unknown',
    progress: summarize(probe),
    profileId: profile.id,
    updatedAt: new Date().toISOString(),
    nextDelayMs: action.delayMs,
  }
  log?.line(site.id, action.note)
  return { state: next, action, probe, applied }
}

/**
 * 启动循环。
 * @param {{ driver: object, store: any, profiles: any, logger: any, intervalMs?: number,
 *           onRound?: (states: Record<string, any>) => void }} deps
 */
export function startLoop(deps) {
  const { driver, store, profiles, logger } = deps
  const minInterval = Math.max(5_000, deps.intervalMs ?? 15_000)
  let stopped = false
  let timer

  async function tick() {
    if (stopped) return
    const sites = store.sites().filter((s) => s.enabled !== false)
    let shortest = 300_000
    for (const site of sites) {
      if (stopped) return
      const prev = store.state(site.id)
      try {
        const profile = profiles.get(site.profileId) ?? profiles.match(site.listUrl)
        if (!profile) throw new Error('没有可用的站点经验；先跑一次 discover 自适应识别')
        const { state } = await stepSite(driver, site, profile, prev, logger)
        store.saveState(site.id, state)
        shortest = Math.min(shortest, state.nextDelayMs ?? minInterval)
      } catch (error) {
        logger.line(site.id, '本轮失败：' + String(error).slice(0, 300))
        store.saveState(site.id, {
          ...prev,
          lastError: String(error).slice(0, 300),
          lastErrorAt: new Date().toISOString(),
          nextDelayMs: 60_000,
        })
        shortest = Math.min(shortest, 60_000)
      }
    }
    if (stopped) return
    try {
      deps.onRound?.(Object.fromEntries(sites.map((s) => [s.id, store.state(s.id)])))
    } catch (error) {
      logger.line('main', '写计划失败：' + String(error).slice(0, 200))
    }
    const wait = Math.max(minInterval, Math.min(shortest, 300_000))
    timer = setTimeout(() => { void tick() }, wait)
    if (typeof timer.unref === 'function') timer.unref()
  }

  timer = setTimeout(() => { void tick() }, 0)
  if (typeof timer.unref === 'function') timer.unref()

  return {
    stop() {
      stopped = true
      if (timer) clearTimeout(timer)
    },
  }
}
