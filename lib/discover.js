// 自适应：没有经验时，从页面本身把结构猜出来。
//
// 两步，缺一不可：
//   1. sniff   —— 在页面里跑一段通用嗅探，收集「像一个课程列表/播放页」的证据
//   2. confirm —— 用猜出来的经验重新探一次，结构必须能复现才算学到
//
// 只有 sniff 没有 confirm 的话，一次偶然的 DOM 抖动就会被写进经验库，
// 以后每次都照着错的东西跑——那比没有经验更糟。

/** 通用嗅探表达式：不依赖任何站点名字，只找「长得像课」的痕迹。 */
export const SNIFF = String.raw`(() => {
  var NL = String.fromCharCode(10);
  var out = { url: location.href, title: (document.title || '').slice(0, 80), videos: [], candidates: [], counters: [] };

  // ① 视频
  [].slice.call(document.querySelectorAll('video')).forEach(function (v, i) {
    out.videos.push({ i: i, d: Math.round(v.duration || 0), t: Math.round(v.currentTime || 0) });
  });

  // ② 带百分比的进度文本：往上找 6 层，看谁的内边距一块里既有百分比又有可点的东西
  var clickable = [].slice.call(document.querySelectorAll('button,a,[role="button"],.btn,li,div[onclick]'));
  var seen = {};
  clickable.forEach(function (el) {
    var t = (el.innerText || '').trim();
    if (!t || t.length > 60) return;
    var p = el, k = 0, block = null;
    for (; k < 6 && p; k++) {
      p = p.parentElement;
      if (!p) break;
      var pt = p.innerText || '';
      if (/[0-9]+\s*%/.test(pt) || /已学完|学习进度|已完成/.test(pt)) { block = p; break; }
    }
    if (!block) return;
    var bt = block.innerText || '';
    var m = bt.match(/([0-9]+)\s*%/);
    var key = t + '|' + (m ? m[1] : '');
    if (seen[key]) return;
    seen[key] = 1;
    out.candidates.push({
      text: t.slice(0, 40),
      tag: el.tagName.toLowerCase(),
      cls: String(el.className).slice(0, 60),
      pct: m ? parseInt(m[1], 10) : -1,
      depth: k
    });
  });

  // ③ 列表型结构：同一父节点下大量同类兄弟（小节/讲次的典型形状）
  var groups = {};
  var sel = function (node) {
    var cls = String(node.className || '').trim().split(/\s+/)[0];
    if (cls) return '.' + cls.replace(/[^a-zA-Z0-9_-]/g, '');
    return String(node.tagName || '').toLowerCase();
  };
  [].slice.call(document.querySelectorAll('li,a,div,span')).forEach(function (el) {
    var p = el.parentElement;
    if (!p) return;
    var cls = String(el.className || '');
    if (!cls) return;
    var css = sel(p) + ' ' + sel(el);
    groups[css] = (groups[css] || 0) + 1;
  });
  Object.keys(groups).forEach(function (k) {
    if (groups[k] >= 3) out.groups = (out.groups || []).concat([{ selector: k, n: groups[k] }]);
  });

  // ④ 页面自己写的进度计数
  var body = (document.body && document.body.innerText) || '';
  ['已学完\\s*([0-9]+)\\s*/\\s*([0-9]+)', '已完成\\s*([0-9]+)\\s*/\\s*([0-9]+)', '([0-9]+)\\s*/\\s*([0-9]+)\\s*课时'].forEach(function (re) {
    var m = body.match(new RegExp(re));
    if (m) out.counters.push({ re: re, text: m[0] });
  });

  return out;
})()`;

/** 从嗅探结果里拼出一份经验草稿。拼不出来就返回 null（明确说「不认识这个页面」）。 */
export function draftFrom(sniff, site) {
  if (!sniff || typeof sniff !== 'object') return null
  const url = String(sniff.url ?? site.listUrl ?? '')
  let domain = ''
  try { domain = new URL(url).host } catch { return null }
  if (!domain) return null

  const profile = {
    id: domain.replace(/^www\./, '').replace(/[^a-z0-9]+/gi, '-') + '-' + Date.now().toString(36),
    name: String(sniff.title ?? domain).slice(0, 60) || domain,
    domain,
    source: 'learned',
    version: 1,
    listPage: {},
    playerPage: { videoSelector: 'video' },
  }

  // 列表页：占比最多的那类可点元素 + 它的文字标签
  const cands = Array.isArray(sniff.candidates) ? sniff.candidates : []
  if (cands.length >= 2) {
    const byTag = {}
    for (const c of cands) {
      const key = c.tag + '|' + c.cls
      byTag[key] = (byTag[key] || 0) + 1
    }
    const best = Object.entries(byTag).sort((a, b) => b[1] - a[1])[0]
    if (best && best[1] >= 2) {
      const tag = best[0].split('|')[0]
      const texts = cands.filter((c) => c.tag === tag).map((c) => c.text)
      const commonText = texts.length > 0 && texts.every((t) => t === texts[0]) ? texts[0] : ''
      profile.listPage.row = {
        clickSelector: tag,
        ...(commonText ? { clickText: commonText } : {}),
        blockUp: 6,
        blockMustContain: '学习进度',
        progressRegex: '([0-9]+)%',
      }
    }
  }

  // 播放页：小节列表（同一父节点下大量同类兄弟）。嗅探直接给出后代选择器。
  const groups = Array.isArray(sniff.groups) ? sniff.groups : []
  if (groups.length > 0) {
    const top = groups.slice().sort((a, b) => b.n - a.n)[0]
    const selector = typeof top?.selector === 'string' ? top.selector.trim() : ''
    if (top && top.n >= 3 && /^[.#a-zA-Z][\w.#\- >]*$/.test(selector)) {
      profile.playerPage.section = { selector, activeClass: 'active', doneText: '已完成' }
    }
  }

  const counters = Array.isArray(sniff.counters) ? sniff.counters : []
  if (counters.length > 0 && counters[0].re) profile.playerPage.counterRegex = counters[0].re

  // 什么特征都没抓到：不算认识这个页面
  const hasList = Boolean(profile.listPage.row)
  const hasSections = Boolean(profile.playerPage.section && profile.playerPage.section.selector)
  const hasVideo = Array.isArray(sniff.videos) && sniff.videos.length > 0
  if (!hasList && !hasSections && !hasVideo) return null
  return profile
}

/**
 * 校验嗅探给出的选择器能用：只允许标签、.class、空格后代、> 子代。
 * 嗅探已经给出 CSS，这里只挡畸形值——不猜哪个词是标签哪个是类名。
 */
export function normalizeSelector(raw) {
  const v = String(raw ?? '').trim()
  if (!v) return ''
  if (!/^[.#a-zA-Z][\w.#\- >]*$/.test(v)) return ''
  return v
}

/** 草稿是否「能用」：至少要能从一个方向推进。 */
export function usable(profile) {
  if (!profile) return { ok: false, why: '没有草稿' }
  const hasRow = Boolean(profile.listPage?.row?.clickSelector)
  const hasSection = Boolean(profile.playerPage?.section?.selector)
  const hasLesson = Boolean(profile.playerPage?.lesson?.selector)
  const hasVideo = Boolean(profile.playerPage?.videoSelector)
  if (!hasRow && !hasSection && !hasLesson) return { ok: false, why: '既没认出课程列表，也没认出小节/讲次' }
  if (!hasVideo) return { ok: false, why: '没认出 video 元素' }
  return { ok: true, why: '' }
}
