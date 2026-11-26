/**
 * dsh-course-autoplay — 浏览器端可视化面板。
 *
 * 三块：会话头部一个入口按钮、一个浮层面板、设置页一张配置卡。
 * 面板里的数据全部来自 Host 的 /api/dsh-course-autoplay/*，客户端不碰会话事件。
 *
 * 手写 bundle 规则（没有构建步骤）：一次 window.__ModuleLoader__.load，
 * 只 require react，用 React.createElement，不写 JSX。
 */
window.__ModuleLoader__.load({
  id: 'dsh-course-autoplay',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    var React = require('react')
    var E = React.createElement
    var useState = React.useState
    var useEffect = React.useEffect

    var TAG = '[autoplay/client]'
    var API = '/course-autoplay'
    var PANEL_ID = 'dsh-course-autoplay:panel'

    // ── 文案 ────────────────────────────────────────────────
    var zh = {
      entry: '挂课',
      title: '网课挂机',
      sub: '用已登录的浏览器播完课程，自动推进到下一节',
      goal: '目标',
      running: '运行中',
      stopped: '已停止',
      start: '开始',
      stop: '停止',
      refresh: '刷新',
      sites: '站点',
      none: '还没有站点。加上课程列表页地址就能开始。',
      add: '添加站点',
      addUrl: '课程列表页地址',
      addPlaceholder: 'https://www.hnzjpx.cn/235/subject',
      addBtn: '添加',
      noProfile: '没有经验，需要先让智能体识别页面',
      hasProfile: '经验',
      progress: '进度',
      unknown: '还没读到条目',
      remove: '移除',
      enable: '启用',
      plan: '计划',
      planNone: '还没有计划，第一次运行时会自动生成',
      log: '日志',
      logNone: '还没有日志',
      settings: '设置',
      interval: '轮询间隔（毫秒）',
      intervalHint: '两轮之间至少等这么久。站点自己要求的间隔更长时以它为准。',
      dataDir: '数据目录',
      bskHome: 'BSK_HOME',
      bskOk: 'bsk 可用',
      bskBad: 'bsk 不可用',
      stageIdle: '未开始',
      stageRunning: '进行中',
      stageDone: '已完成',
      stageStuck: '卡住',
      failed: '失败',
      close: '收起',
      loading: '读取中…',
    }
    var en = {
      entry: 'Autoplay',
      title: 'Course autoplay',
      sub: 'Plays course videos in your logged-in browser and advances lesson by lesson',
      goal: 'Goal',
      running: 'Running',
      stopped: 'Stopped',
      start: 'Start',
      stop: 'Stop',
      refresh: 'Refresh',
      sites: 'Sites',
      none: 'No sites yet. Add a course list URL to begin.',
      add: 'Add site',
      addUrl: 'Course list URL',
      addPlaceholder: 'https://www.hnzjpx.cn/235/subject',
      addBtn: 'Add',
      noProfile: 'No profile yet — the agent must discover this site',
      hasProfile: 'Profile',
      progress: 'Progress',
      unknown: 'No entries read yet',
      remove: 'Remove',
      enable: 'Enabled',
      plan: 'Plan',
      planNone: 'No plan yet; the first run writes one',
      log: 'Log',
      logNone: 'No log yet',
      settings: 'Settings',
      interval: 'Poll interval (ms)',
      intervalHint: 'Minimum wait between rounds. A site-required wait overrides it.',
      dataDir: 'Data directory',
      bskHome: 'BSK_HOME',
      bskOk: 'bsk available',
      bskBad: 'bsk unavailable',
      stageIdle: 'Not started',
      stageRunning: 'Running',
      stageDone: 'Done',
      stageStuck: 'Stuck',
      failed: 'Failed',
      close: 'Close',
      loading: 'Loading…',
    }
    // 语言：先问宿主 locale，拿不到就按浏览器语言猜，最后退回中文
    var LANG = 'zh'
    function detectLang(ctx) {
      try {
        var l = ctx && ctx.locale && typeof ctx.locale.current === 'function' ? ctx.locale.current() : null
        if (typeof l === 'string' && l) return l.toLowerCase().indexOf('zh') === 0 ? 'zh' : 'en'
      } catch (e) { /* 继续猜 */ }
      try {
        var nav = typeof navigator !== 'undefined' ? String(navigator.language || '') : ''
        if (nav) return nav.toLowerCase().indexOf('zh') === 0 ? 'zh' : 'en'
      } catch (e) { /* 继续 */ }
      return 'zh'
    }
    function t(key) {
      var d = LANG === 'en' ? en : zh
      var v = d[key]
      if (v != null) return v
      return zh[key] != null ? zh[key] : key
    }

    // ── 面板开关（模块级，按钮和浮层共用） ───────────────────
    var openState = false
    var listeners = new Set()
    function setOpen(next) {
      openState = next
      listeners.forEach(function (fn) { try { fn(next) } catch (e) { console.warn(TAG, e) } })
    }
    function useOpen() {
      var pair = useState(openState)
      var value = pair[0], set = pair[1]
      useEffect(function () {
        listeners.add(set)
        return function () { listeners.delete(set) }
      }, [])
      return [value, setOpen]
    }

    // ── Host 通信 ───────────────────────────────────────────
    // 宿主这条路由只接 GET/HEAD，参数走查询串（同 dsh-restart-button 的做法）。
    function post(path, body) {
      var qs = Object.keys(body || {}).map(function (k) {
        var v = body[k]
        return encodeURIComponent(k) + '=' + encodeURIComponent(v === undefined || v === null ? '' : String(v))
      }).join('&')
      return fetch(API + path + (qs ? '?' + qs : ''), { method: 'GET', headers: { accept: 'application/json' } })
        .then(function (r) { return r.json() }).then(function (j) {
        if (!j || j.ok !== true) throw new Error((j && j.error && j.error.message) || 'request failed')
        return j.value
      })
    }

    // ── 样式 ────────────────────────────────────────────────
    // 样式表 id 带版本号：插件热更新后旧样式表还在（同一 id 会被 return 挡住），
    // 上一版用的字面色 token 就会一直生效——实测表现为深色界面里弹出一块白板。
    var STYLE_ID = 'dsh-course-autoplay-styles-v2'
    function ensureStyles() {
      if (typeof document === 'undefined') return
      if (document.getElementById(STYLE_ID)) return
      // 清掉更早版本留下的样式表，避免两套规则打架
      var stale = document.querySelectorAll('style[id^="dsh-course-autoplay-styles"]')
      for (var i = 0; i < stale.length; i += 1) {
        if (stale[i].id !== STYLE_ID) stale[i].parentNode.removeChild(stale[i])
      }
      var el = document.createElement('style')
      el.id = STYLE_ID
      // 只用宿主真实存在的主题 token（从 dsh-pipem / dsh-context / dsh-better-sidebar 里核出来的），
      // 不用字面色值：字面色在深色/浅色切换时会变成「浅色叠浅色」看不见。
      el.textContent = [
        '.ap-btn{display:inline-flex;align-items:center;gap:6px;height:26px;padding:0 9px;border-radius:6px;' +
          'border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary);' +
          'font-size:var(--dsw-font-xxs-12);font-family:var(--dsw-font-family);cursor:pointer}',
        '.ap-btn:hover{background:var(--dsw-alias-interactive-bg-hover)}',
        '.ap-btn:disabled{opacity:.5;cursor:not-allowed}',
        '.ap-badge{min-width:16px;height:16px;padding:0 4px;border-radius:8px;font-size:10px;line-height:16px;' +
          'text-align:center;background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary-foreground)}',
        '.ap-overlay{position:fixed;inset:0;z-index:60;display:flex;align-items:flex-start;justify-content:center;' +
          'background:var(--dsw-alias-bg-mask-1);padding:56px 24px 24px}',
        '.ap-panel{width:min(880px,100%);max-height:calc(100vh - 96px);overflow:auto;border-radius:12px;' +
          'background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);' +
          'border:1px solid var(--dsw-alias-border-l2);box-shadow:var(--dsw-shadow-lv3);display:flex;flex-direction:column}',
        '.ap-head{display:flex;align-items:center;gap:10px;padding:14px 16px;' +
          'border-bottom:1px solid var(--dsw-alias-border-l1)}',
        '.ap-head h3{margin:0;font-size:var(--dsw-font-s-14);font-weight:600;color:var(--dsw-alias-label-primary)}',
        '.ap-head .ap-sub{font-size:var(--dsw-font-xxs-12);color:var(--dsw-alias-label-tertiary)}',
        '.ap-spacer{flex:1}',
        '.ap-body{padding:14px 16px;display:flex;flex-direction:column;gap:12px}',
        '.ap-card{border:1px solid var(--dsw-alias-border-l2);border-radius:10px;padding:12px 14px;' +
          'display:flex;flex-direction:column;gap:10px;background:var(--dsw-alias-bg-layer-2)}',
        '.ap-card h4{margin:0;font-size:var(--dsw-font-xxxs-11);letter-spacing:.06em;text-transform:uppercase;' +
          'color:var(--dsw-alias-label-tertiary)}',
        '.ap-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}',
        '.ap-site{display:flex;flex-direction:column;gap:6px;padding:10px 0;' +
          'border-bottom:1px solid var(--dsw-alias-border-l1)}',
        '.ap-site:last-child{border-bottom:none}',
        '.ap-site .ap-name{font-size:var(--dsw-font-xs-13);font-weight:600;color:var(--dsw-alias-label-primary)}',
        '.ap-chip{font-size:var(--dsw-font-xxxs-11);padding:1px 7px;border-radius:9px;' +
          'border:1px solid var(--dsw-alias-border-l2)}',
        '.ap-chip.idle{color:var(--dsw-alias-label-tertiary)}',
        '.ap-chip.running{color:var(--dsw-alias-state-business-primary);border-color:currentColor}',
        '.ap-chip.done{color:var(--dsw-alias-state-success-primary);border-color:currentColor}',
        '.ap-chip.stuck{color:var(--dsw-alias-state-error-primary);border-color:currentColor}',
        '.ap-bar{position:relative;height:6px;border-radius:3px;overflow:hidden;min-width:120px;flex:1;' +
          'background:var(--dsw-alias-border-l1)}',
        '.ap-bar i{position:absolute;inset:0 auto 0 0;display:block;background:var(--dsw-alias-brand-primary)}',
        '.ap-num{font-size:var(--dsw-font-xxs-12);color:var(--dsw-alias-label-secondary);' +
          'font-variant-numeric:tabular-nums}',
        '.ap-note{font-size:var(--dsw-font-xxs-12);color:var(--dsw-alias-label-tertiary)}',
        '.ap-err{font-size:var(--dsw-font-xxs-12);color:var(--dsw-alias-state-error-primary)}',
        '.ap-input{flex:1;min-width:220px;height:28px;padding:0 9px;border-radius:6px;' +
          'font-size:var(--dsw-font-xxs-12);border:1px solid var(--dsw-alias-border-l2);' +
          'background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary)}',
        '.ap-pre{margin:0;padding:10px;border-radius:8px;font-size:var(--dsw-font-xxxs-11);line-height:1.6;' +
          'font-family:var(--dsw-font-mono);background:var(--dsw-alias-bg-base);' +
          'color:var(--dsw-alias-label-secondary);max-height:200px;overflow:auto;white-space:pre-wrap}',
        '.ap-kv{display:flex;gap:8px;font-size:var(--dsw-font-xxs-12);color:var(--dsw-alias-label-tertiary)}',
      ].join('\n')
      document.head.appendChild(el)
    }

    function pctOf(p) {
      if (!p || !p.total) return null
      return Math.max(0, Math.min(100, Math.round((Number(p.done || 0) / Number(p.total)) * 100)))
    }
    function barWidth(p) {
      var v = pctOf(p)
      return (v === null ? 0 : v) + '%'
    }
    function pctText(p) {
      var v = pctOf(p)
      return v === null ? '—' : v + '%'
    }
    function countText(p) {
      if (!p || !p.total) return t('unknown')
      return String(p.done || 0) + '/' + String(p.total)
    }

    /** 把 ISO 时间变成「刚刚 / N 分钟前 / N 小时前」，面板上看得出新旧。 */
    function agoText(iso) {
      if (!iso) return ''
      var ts = Date.parse(iso)
      if (!Number.isFinite(ts)) return ''
      var mins = Math.max(0, Math.round((Date.now() - ts) / 60000))
      if (mins < 1) return '刚刚'
      if (mins < 60) return mins + ' 分钟前'
      var hours = Math.round(mins / 60)
      if (hours < 24) return hours + ' 小时前'
      return Math.round(hours / 24) + ' 天前'
    }

    /** 没有计划文档时，用当前站点自己算一句目标，别把插件名当目标显示。 */
    function localGoal(sites) {
      if (!sites || sites.length === 0) return '还没有站点'
      var total = 0
      var known = 0
      sites.forEach(function (s) {
        if (s.progress && typeof s.progress.total === 'number' && s.progress.total > 0) {
          total += s.progress.total
          known += 1
        }
      })
      var names = sites.map(function (s) { return s.label || s.id }).join('、')
      if (known === 0) return '把 ' + names + ' 的课挂完'
      return '把 ' + names + ' 共 ' + total + ' 个条目挂完'
    }

    function stageLabel(stage) {
      if (stage === 'done') return t('stageDone')
      if (stage === 'running') return t('stageRunning')
      if (stage === 'stuck') return t('stageStuck')
      return t('stageIdle')
    }

    // ── 面板 ────────────────────────────────────────────────
    function Panel() {
      // 开关状态在模块里（按钮和浮层共用），不能指望 slot 给自己传 open
      var openPair = useOpen()
      var open = openPair[0]
      var s2 = useState(null), data = s2[0], setData = s2[1]
      var s3 = useState(''), error = s3[0], setError = s3[1]
      var s4 = useState(''), url = s4[0], setUrl = s4[1]
      var s5 = useState(false), busy = s5[0], setBusy = s5[1]

      function load() {
        post('/state', {}).then(function (v) { setData(v); setError('') }).catch(function (e) {
          console.warn(TAG, 'state failed', e)
          setError(String(e.message || e))
        })
      }

      useEffect(function () {
        if (!open) return
        ensureStyles()
        load()
        var timer = setInterval(load, 5000)
        return function () { clearInterval(timer) }
      }, [open])

      if (!open) return null

      function act(fn) {
        setBusy(true)
        fn().then(function () { load() }).catch(function (e) { setError(String(e.message || e)) })
          .then(function () { setBusy(false) })
      }

      var sites = (data && data.sites) || []
      var loading = data === null
      var plan = data && data.plan
      var overall = plan && plan.goal && plan.goal.progress ? plan.goal.progress : null
      var doneSites = sites.filter(function (s) { return s.stage === 'done' }).length

      var children = [
        E('div', { className: 'ap-head', key: 'head' },
          E('h3', null, t('title')),
          E('span', { className: 'ap-sub' }, t('sub')),
          E('span', { className: 'ap-spacer' }),
          data ? E('span', { className: 'ap-chip ' + (data.looping ? 'running' : 'idle') },
            data.looping ? t('running') : t('stopped')) : null,
          E('button', {
            className: 'ap-btn',
            onClick: function () { act(function () { return post('/run', { action: data && data.looping ? 'stop' : 'start' }) }) },
            disabled: busy || !data,
          }, data && data.looping ? t('stop') : t('start')),
          E('button', { className: 'ap-btn', onClick: load }, t('refresh')),
          E('button', { className: 'ap-btn', onClick: function () { setOpen(false) } }, t('close')),
        ),
        E('div', { className: 'ap-body', key: 'body' },
          error ? E('div', { className: 'ap-err' }, error) : null,
          loading ? E('div', { className: 'ap-note' }, t('loading')) : null,

          data && !data.bskReady ? E('div', { className: 'ap-card', key: 'health' },
            E('h4', null, '环境'),
            E('div', { className: 'ap-err' }, 'bsk 不可用：' + (data.bskError || '未知原因')),
            E('div', { className: 'ap-note' }, '挂课要靠 bsk 驱动浏览器。装好 bsk、连上扩展，再在 DSH 之外跑 bsk daemon start --foreground。'),
          ) : null,

          E('section', { className: 'ap-card' },
            E('h4', null, t('goal')),
            E('div', { className: 'ap-row' },
              E('strong', null, (plan && plan.goal && plan.goal.text) || localGoal(sites)),
              E('span', { className: 'ap-spacer' }),
              E('span', { className: 'ap-num' },
                overall && overall.total
                  ? overall.done + '/' + overall.total
                  : (sites.length > 0 ? doneSites + ' 站已完成 / ' + sites.length + ' 站' : '—')),
            ),
            E('div', { className: 'ap-bar' },
              E('i', { style: { width: barWidth(overall) } })),
            E('div', { className: 'ap-kv' },
              E('span', null, t('progress') + ' ' + pctText(overall)),
              E('span', null, (data ? (data.logTail || []).length : 0) + ' 条' + t('log')),
            ),
          ),

          E('section', { className: 'ap-card' },
            E('h4', null, t('sites')),
            sites.length === 0 ? E('div', { className: 'ap-note' }, t('none')) : null,
            sites.map(function (s) {
              return E('div', { className: 'ap-site', key: s.id },
                E('div', { className: 'ap-row' },
                  E('span', { className: 'ap-name' }, s.label),
                  E('span', { className: 'ap-chip ' + s.stage }, stageLabel(s.stage)),
                  s.profileId ? E('span', { className: 'ap-note' }, t('hasProfile') + ' ' + s.profileId)
                    : E('span', { className: 'ap-err' }, t('noProfile')),
                  E('span', { className: 'ap-spacer' }),
                  E('button', {
                    className: 'ap-btn',
                    onClick: function () { act(function () { return post('/save', { id: s.id, enabled: !s.enabled }) }) },
                  }, (s.enabled ? '✓ ' : '✗ ') + t('enable')),
                  E('button', {
                    className: 'ap-btn',
                    onClick: function () { act(function () { return post('/save', { id: s.id, remove: true }) }) },
                  }, t('remove')),
                ),
                E('div', { className: 'ap-row' },
                  E('div', { className: 'ap-bar' }, E('i', { style: { width: barWidth(s.progress) } })),
                  E('span', { className: 'ap-num' }, countText(s.progress)),
                ),
                s.lastNote ? E('div', { className: 'ap-note' }, s.lastNote) : null,
                s.lastError
                  ? E('div', { className: 'ap-err' },
                    (s.lastErrorAt ? '[' + agoText(s.lastErrorAt) + '] ' : '') + s.lastError)
                  : null,
              )
            }),
            E('div', { className: 'ap-row' },
              E('input', {
                className: 'ap-input',
                placeholder: t('addPlaceholder'),
                value: url,
                onChange: function (e) { setUrl(e.target.value) },
              }),
              E('button', {
                className: 'ap-btn',
                disabled: busy || !url,
                onClick: function () {
                  act(function () { return post('/add', { listUrl: url }).then(function (v) { setUrl(''); return v }) })
                },
              }, t('addBtn')),
            ),
          ),

          E('section', { className: 'ap-card' },
            E('h4', null, t('plan')),
            E('pre', { className: 'ap-pre' },
              (data && data.planMarkdown) || t('planNone')),
          ),

          E('section', { className: 'ap-card' },
            E('h4', null, t('log')),
            E('pre', { className: 'ap-pre' },
              (data && data.logTail && data.logTail.length) ? data.logTail.slice(-24).join('\n') : t('logNone')),
          ),

          E('section', { className: 'ap-card' },
            E('h4', null, t('settings')),
            E('div', { className: 'ap-kv' }, E('span', null, t('dataDir') + '：' + (data ? data.dataDir : '—'))),
            E('div', { className: 'ap-kv' }, E('span', null, t('bskHome') + '：' + (data ? data.bskHome : '—'))),
            E('div', { className: 'ap-row' },
              E('span', { className: data && data.bskReady ? 'ap-note' : 'ap-err' },
                data && data.bskReady ? t('bskOk') : (t('bskBad') + (data && data.bskError ? '：' + data.bskError : ''))),
            ),
            E('div', { className: 'ap-row' },
              E('span', { className: 'ap-note' }, t('interval')),
              E('span', { className: 'ap-num' }, data ? String(data.intervalMs) : '—'),
              E('span', { className: 'ap-spacer' }),
              E('span', { className: 'ap-note' }, t('intervalHint')),
            ),
          ),
        ),
      ]

      return E('div', {
        className: 'ap-overlay',
        onClick: function (e) { if (e.target === e.currentTarget) setOpen(false) },
      }, E('div', { className: 'ap-panel' }, children))
    }

    // ── 会话头部入口 ────────────────────────────────────────
    function HeaderEntry() {
      var pair = useOpen()
      var open = pair[0]
      var s = useState(null), badge = s[0], setBadge = s[1]
      useEffect(function () {
        ensureStyles()
        var timer = setInterval(function () {
          post('/state', {}).then(function (v) {
            var sites = v.sites || []
            var running = sites.filter(function (x) { return x.stage === 'running' }).length
            setBadge({ total: sites.length, running: running, looping: v.looping })
          }).catch(function () { /* 面板打开时会报错，这里安静 */ })
        }, 8000)
        return function () { clearInterval(timer) }
      }, [])
      return E('button', {
        className: 'ap-btn',
        title: t('title'),
        onClick: function () { pair[1](!open) },
      },
        t('entry'),
        badge && badge.total ? E('span', { className: 'ap-badge' }, String(badge.total)) : null)
    }

    exports.name = 'dsh-course-autoplay/client'
    exports.inject = ['slots']

    exports.apply = function (ctx) {
      LANG = detectLang(ctx)
      try {
        ctx.effect(function () {
          ensureStyles()
          return function () { /* 样式留着，卸载后重装不会重复插入 */ }
        })
      } catch (e) { console.warn(TAG, 'styles failed', e) }

      try {
        var slots = ctx.slots
        if (!slots || typeof slots.inject !== 'function') {
          console.warn(TAG + ' slots unavailable; panel idle')
          return
        }
        slots.inject('conversation.session.header.utilities', function () {
          return slots.register({
            name: 'conversation.session.header.utilities',
            id: 'dsh-course-autoplay-entry',
            order: 30,
            registrant: 'dsh-course-autoplay',
          }, HeaderEntry)
        })
        slots.inject('shell.overlay', function () {
          return slots.register({
            name: 'shell.overlay',
            id: PANEL_ID,
            order: 30,
            registrant: 'dsh-course-autoplay',
          }, Panel)
        })
      } catch (e) { console.warn(TAG + ' slot registration failed', e) }
    }

    return module.exports
  },
})
