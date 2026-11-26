// 引擎：把一份「站点经验」变成三样东西——页面探针 JS、决策函数、动作执行。
//
// 为什么经验是数据不是代码：2026-11-26 起的版本要求「有经验就复用，没有就自适应」。
// 内置站点（hunnu / hnzjpx）和自适应学到的站点必须走同一条路，否则学到的经验
// 永远是二等公民，只会在它们身上犯错。所以两边都只是 JSON：
//
//   lib/profiles/*.json        内置经验（随插件发布）
//   <dataDir>/profiles/*.json  学到的经验（自适应写入，可手改、可删）
//
// 这里不含任何站点名字，只有「列表页长什么样、播放页长什么样」的字段。

/** 把用户给的字符串塞进 JS 字符串字面量。绝不拼接裸文本进表达式。 */
function js(value) {
  return JSON.stringify(String(value))
}

/** 从经验里生成一段在页面里跑的探针表达式。 */
export function probeScript(profile) {
  const list = profile.listPage ?? {}
  const player = profile.playerPage ?? {}
  const row = list.row ?? {}
  const section = player.section ?? {}
  const lesson = player.lesson ?? {}
  const videoSel = player.videoSelector ?? 'video'

  const parts = [
    '(() => {',
    '  var NL = String.fromCharCode(10);',
    '  var out = { url: location.href, title: (document.title || "").slice(0, 80) };',
    '  var v = document.querySelector(' + js(videoSel) + ');',
    '  out.video = v ? { t: Math.round(v.currentTime || 0), d: Math.round(v.duration || 0), paused: !!v.paused, rate: v.playbackRate } : null;',
  ]

  // ── 列表页：一排「立即学习」按钮，每个按钮往上找一块带进度的卡片 ──
  if (row.clickSelector) {
    parts.push(
      '  var btns = [].slice.call(document.querySelectorAll(' + js(row.clickSelector) + '));',
      row.clickText
        ? '  btns = btns.filter(function (b) { return (b.innerText || "").trim() === ' + js(row.clickText) + '; });'
        : '  btns = btns.filter(function (b) { return String(b.className).indexOf("btn") >= 0 || b.tagName === "BUTTON" || b.tagName === "A"; });',
      '  var rows = btns.map(function (b, i) {',
      '    var p = b, k = 0, up = ' + Number(row.blockUp ?? 6) + ';',
      '    var must = ' + js(row.blockMustContain ?? '') + ';',
      '    if (must) { for (; k < up && p; k++) { p = p.parentElement; if (p && (p.innerText || "").indexOf(must) >= 0) break; } }',
      '    var t = p ? (p.innerText || "") : "";',
      '    var m = t.match(new RegExp(' + js(row.progressRegex ?? '([0-9]+)%') + '));',
      '    var lines = t.split(NL).map(function (x) { return x.trim(); }).filter(function (x) { return x && x.indexOf("%") < 0; });',
      '    return { i: i, title: (lines[0] || "").slice(0, 60), pct: m ? parseInt(m[1], 10) : -1 };',
      '  });',
      '  out.rows = rows;',
      '  out.mode = rows.length > 0 ? "list" : "unknown";',
    )
  }

  // ── 播放页：小节列表 ──
  if (section.selector) {
    parts.push(
      '  var secs = [].slice.call(document.querySelectorAll(' + js(section.selector) + ')).map(function (s, i) {',
      '    var t = (s.innerText || "").split(NL).join(" ");',
      '    return { i: i, txt: t.slice(0, 60),',
      '      active: String(s.className).indexOf(' + js(section.activeClass ?? 'active') + ') >= 0,',
      '      done: t.indexOf(' + js(section.doneText ?? '已完成') + ') >= 0 };',
      '  });',
      '  if (secs.length > 0) { out.sections = secs; out.mode = "player"; }',
    )
  }

  // ── 播放页：讲次列表（带 href 的链接） ──
  if (lesson.selector) {
    parts.push(
      '  var lessons = [].slice.call(document.querySelectorAll(' + js(lesson.selector) + ')).map(function (el, i) {',
      '    var cn = String(el.className);',
      '    var t = (el.innerText || "").trim().split(NL)[0];',
      '    return { i: i, txt: t.slice(0, 60),',
      '      href: el.getAttribute(' + js(lesson.hrefAttr ?? 'href') + ') || "",',
      '      active: cn.indexOf(' + js(lesson.activeClass ?? 'active') + ') >= 0,',
      '      done: cn.indexOf(' + js(lesson.doneClass ?? 'done') + ') >= 0 };',
      '  });',
      '  if (lessons.length > 0) { out.lessons = lessons; out.mode = "player"; }',
    )
  }

  // ── 平台自己写的进度计数（「已学完 3/12」这种） ──
  if (player.counterRegex) {
    parts.push(
      '  var body = (document.body && document.body.innerText) || "";',
      '  var cm = body.match(new RegExp(' + js(player.counterRegex) + '));',
      '  if (cm) { out.counter = { text: cm[0], done: parseInt(cm[1], 10), total: parseInt(cm[2], 10) }; }',
    )
  }

  parts.push('  if (out.mode === undefined) out.mode = "unknown";', '  return out;', '})()')
  return parts.join('\n')
}

/**
 * 决定下一步。纯函数，不碰浏览器——这是整个插件最该被测的一块。
 *
 * 返回 { action, index?, delayMs, note }，action 是：
 *   play  播放当前视频
 *   click 点第 index 个条目（课 / 小节 / 讲次）
 *   open  跳到 url（缺省 = 重载当前页）
 *   up    回课程列表
 *   stay  都做完了，歇着
 */
export function plan(state, site, mem = {}) {
  const stuck = Number(mem.stuck ?? 0)
  if (!state || typeof state !== 'object') {
    return { action: 'open', url: site.listUrl, delayMs: 20_000, note: '读不到页面结构，回列表' }
  }
  const video = state.video && state.video.d > 0 ? state.video : null
  const pct = video ? Math.round((video.t * 100) / video.d) : 0

  // ① 列表页：挑第一门没满 100% 的课
  if (Array.isArray(state.rows) && state.rows.length > 0) {
    const done = state.rows.filter((r) => r.pct === 100).length
    const todo = state.rows.find((r) => r.pct !== 100)
    if (!todo) return { action: 'stay', delayMs: 600_000, note: '全部 ' + state.rows.length + ' 门已完成' }
    return {
      action: 'click',
      index: todo.i,
      delayMs: 12_000,
      note: '完成 ' + done + '/' + state.rows.length + '，开始第 ' + (todo.i + 1) + ' 门：' + (todo.title || ''),
    }
  }

  // ② 播放页：小节列表
  if (Array.isArray(state.sections) && state.sections.length > 0) {
    const doneN = state.sections.filter((s) => s.done).length
    const active = state.sections.find((s) => s.active)
    const target = state.sections.find((s) => !s.done)
    if (!target) return { action: 'up', delayMs: 12_000, note: '小节 ' + doneN + '/' + state.sections.length + ' 全部完成，回列表' }
    if (!active || active.i !== target.i) {
      return { action: 'click', index: target.i, delayMs: 8_000, note: '切到未完成小节 ' + (target.i + 1) + '/' + state.sections.length }
    }
    if (!video) {
      if (stuck >= 4) return { action: 'up', delayMs: 20_000, note: '连续 ' + stuck + ' 次没读到视频时长，回列表' }
      return { action: 'play', delayMs: 10_000, note: '还没读到视频，先试着播' }
    }
    if (video.t >= video.d - 3) return { action: 'play', delayMs: 20_000, note: '本节播到末尾，等平台标记完成' }
    return { action: 'play', delayMs: 45_000, note: '播放第 ' + (active.i + 1) + '/' + state.sections.length + '节 ' + video.t + '/' + video.d + 's (' + pct + '%)' }
  }

  // ③ 播放页：讲次列表
  if (Array.isArray(state.lessons) && state.lessons.length > 0) {
    const active = state.lessons.find((l) => l.active)
    const target = state.lessons.find((l) => !l.done)
    if (active && active.done) {
      if (target && target.i !== active.i) {
        return { action: 'click', index: target.i, delayMs: 8_000, note: '第 ' + (active.i + 1) + ' 讲已完成，转第 ' + (target.i + 1) + ' 讲' }
      }
      return { action: 'up', delayMs: 20_000, note: '本页讲次都完成了，回列表' }
    }
    if (!video) {
      if (stuck >= 4) return { action: 'open', url: state.url, delayMs: 20_000, note: '连续 ' + stuck + ' 次没读到视频，重载页面' }
      return { action: 'play', delayMs: 10_000, note: '还没读到视频，先试着播' }
    }
    if (video.t >= video.d - 3) return { action: 'play', delayMs: 20_000, note: '本讲播到末尾，等平台标记完成' }
    const counter = state.counter ? '（平台计数 ' + state.counter.done + '/' + state.counter.total + '）' : ''
    return { action: 'play', delayMs: 45_000, note: '第 ' + ((active?.i ?? 0) + 1) + ' 讲 ' + video.t + '/' + video.d + 's (' + pct + '%)' + counter }
  }

  // ④ 只有视频、没有列表：单集播放
  if (video) {
    if (video.t >= video.d - 3) return { action: 'stay', delayMs: 300_000, note: '这一集播完了，没有可推进的列表' }
    return { action: 'play', delayMs: 45_000, note: '播放 ' + video.t + '/' + video.d + 's (' + pct + '%)' }
  }

  // ⑤ 什么都没有：可能是没登录、被弹窗挡住、或者进错了页面
  if (stuck >= 4) {
    return { action: 'open', url: site.listUrl, delayMs: 30_000, note: '连续 ' + stuck + ' 次读不到视频和列表，回列表页' }
  }
  return { action: 'open', url: site.listUrl, delayMs: 15_000, note: '页面里没有视频也没有课程列表，回列表页' }
}

/** 播放表达式：固定 1 倍速（多数培训站点会校验倍速，改快了学时不算）。 */
export const PLAY = '(() => { var v = document.querySelector("video"); if (!v) return { ok: false, why: "no-video" };' +
  ' if (v.playbackRate !== 1) v.playbackRate = 1; if (v.paused) { try { v.play(); } catch (e) {} }' +
  ' return { ok: true, paused: !!v.paused, rate: v.playbackRate }; })()'

/** 执行一步动作。 */
export async function apply(driver, session, action, site, profile) {
  if (action.action === 'play') return driver.evaluate(session, PLAY)

  if (action.action === 'open') {
    const target = action.url || site.listUrl
    const where = await driver.evaluate(session, '(() => location.href)()')
    if (typeof where === 'string' && where.split('?')[0] === String(target).split('?')[0]) {
      return driver.evaluate(session, '(() => { location.reload(); return { ok: true, reload: true }; })()')
    }
    return driver.evaluate(session, '(() => { location.href = ' + js(target) + '; return { ok: true, to: ' +
      js(target) + ' }; })()')
  }

  if (action.action === 'up') {
    return driver.evaluate(session, '(() => { location.href = ' + js(site.listUrl) + '; return { ok: true }; })()')
  }

  if (action.action === 'click') {
    const row = profile?.listPage?.row
    const section = profile?.playerPage?.section
    const lesson = profile?.playerPage?.lesson
    const idx = Number(action.index)
    // 依次尝试：小节 → 讲次 → 列表页按钮。谁存在点谁，这是「页面决定用哪条」而不是「我先猜模式」。
    const script = [
      '(() => {',
      '  var i = ' + idx + ';',
      section?.selector
        ? '  var secs = [].slice.call(document.querySelectorAll(' + js(section.selector) + '));\n' +
          '  if (secs.length > 0) { if (!secs[i]) return { ok: false, why: "no-section", n: secs.length }; secs[i].click(); return { ok: true, kind: "section" }; }'
        : '',
      lesson?.selector
        ? '  var les = [].slice.call(document.querySelectorAll(' + js(lesson.selector) + '));\n' +
          '  if (les.length > 0) { if (!les[i]) return { ok: false, why: "no-lesson", n: les.length }; les[i].click(); return { ok: true, kind: "lesson" }; }'
        : '',
      row?.clickSelector
        ? '  var bs = [].slice.call(document.querySelectorAll(' + js(row.clickSelector) + '));\n' +
          (row.clickText ? '  bs = bs.filter(function (b) { return (b.innerText || "").trim() === ' + js(row.clickText) + '; });\n' : '') +
          '  if (!bs[i]) return { ok: false, why: "no-row", n: bs.length };\n' +
          '  bs[i].click(); return { ok: true, kind: "row" };'
        : '  return { ok: false, why: "no-clickable" };',
      '})()',
    ].filter(Boolean).join('\n')
    return driver.evaluate(session, script)
  }

  return null
}

/** 一次探针跑完后，把页面状态压成一句进度话，给列表和面板显示。 */
export function summarize(state) {
  if (!state) return { kind: 'unknown' }
  if (Array.isArray(state.rows) && state.rows.length > 0) {
    return { kind: 'courses', done: state.rows.filter((r) => r.pct === 100).length, total: state.rows.length }
  }
  if (Array.isArray(state.sections) && state.sections.length > 0) {
    return { kind: 'sections', done: state.sections.filter((s) => s.done).length, total: state.sections.length, title: state.title }
  }
  if (Array.isArray(state.lessons) && state.lessons.length > 0) {
    return {
      kind: 'lessons',
      done: state.lessons.filter((l) => l.done).length,
      total: state.lessons.length,
      platformDone: state.counter ? state.counter.done : null,
      platformTotal: state.counter ? state.counter.total : null,
      title: state.title,
    }
  }
  if (state.video && state.video.d > 0) {
    return { kind: 'video', done: 0, total: 1, title: state.title, seconds: state.video.d }
  }
  return { kind: 'unknown', title: state.title }
}
