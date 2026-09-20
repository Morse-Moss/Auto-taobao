// 日报链「采集段」的纯函数：挑新下载的文件、认下载任务名、校验统计区间含目标日。
//
// 为什么要单独拎出来（2026-09-17）：采集段一直是**操作步骤**（SOP §3/§4 里写的点击路径），
// 现场靠 %Temp% 下的临时脚本点，没有仓库内的实现。对客户演示来说这是最容易出纰漏的一环：
// 临时脚本会被清理、参数写死、失败时只留一句沉默。收编时把「判断」与「点页面」分开 ——
// 判断留在本模块（可离线单测），点页面留在线脚本里（浏览器里现跑）。
import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';

// 生意参谋店铺报表与阿里妈妈推广报表的文件名形状（实测）。
//
// 2026-09-18 放宽前缀（原先写死 `日报_`）：**报表名是每店自己的**。
// 实测「盖文淘宝」那一份落盘叫 `日报2_20260918_90f3f449….xlsx`，而同一轮里
// 「里可林家居」「网林家居旗舰店」都叫 `日报_`。顺着页面 URL 还能看到
// 每店的报表定义 id 也不同（盖文淘宝 reportId=4300822，而仓库注释里记的是 4300764）。
//
// 判据太窄的后果是**静默的**，而且报错方向会把人带偏：下载明明成功、文件就躺在下载目录里，
// 脚本却一路「等待下载…」直到超时，最后报「没等到新的店铺报表」——看起来像站点没响应，
// 实际是本地正则不认这个文件名（2026-09-18 实亏一次，靠人工翻下载目录才查出来）。
//
// 放宽的只是前缀里的数字；`_\d{8}_<hex>.xlsx` 这段形状照旧 ——
// 那是「下载日 + 内容哈希」，哈希实测是**按店铺**变的（见 collect-shop-report.mjs 的注释）。
export const SHOP_REPORT_PATTERN = /^日报\d*_\d{8}_[0-9a-f]+(?: \(\d+\))?\.xlsx$/u;
export const PROMOTION_ZIP_PATTERN = /^营销场景报表_\d{8}_\d{6}(?: \(\d+\))?\.zip$/u;
// 下载任务在「下载任务管理」里的行名（不含后缀）。
export const PROMOTION_TASK_PATTERN = /^营销场景报表_(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})$/u;

// 浏览器的默认下载目录。写死在仓库里会把别人的机器路径带进来，所以从环境变量推。
export function defaultDownloadsDir(env = process.env) {
  const home = env.USERPROFILE || env.HOME;
  if (!home) throw new Error('cannot derive the downloads directory: set USERPROFILE/HOME or pass --downloads');
  return path.join(home, 'Downloads');
}

export function listDownloads(dir, pattern) {
  let names;
  try {
    names = readdirSync(dir);
  } catch (error) {
    throw new Error(`cannot read downloads directory ${dir}: ${error.message}`);
  }
  return names
    .filter((name) => pattern.test(name))
    .map((name) => {
      // 「大小 + mtime」是本函数唯一的判据来源；读不到 stat 的条目直接不算候选（假文件不进候选集）。
      const stat = statSync(path.join(dir, name), { throwIfNoEntry: false });
      return stat ? { name, size: stat.size, mtimeMs: stat.mtimeMs } : null;
    })
    .filter(Boolean);
}

// 「点击前记一份名单 → 点击后只认名单里没有的」——判据取文件系统，不取页面上的按钮状态。
// 页面说「生成成功」不等于文件落到了磁盘；反过来，页面卡在旧状态时文件也可能已经下来了。
//
// 两边都是**文件名数组**（不是 listDownloads 的对象）。写这条注释是因为第一版把右边按
// `entry.name` 取、左边是字符串数组，于是 `known.has(undefined)` 恒 false ——
// 过滤静默失效，「所有文件都算新的」，取件步骤会把旧 zip 当成刚下载的那一份。
export function newEntries(before, after) {
  const known = new Set(before);
  return after.filter((name) => !known.has(name));
}

// 多个新文件时取 mtime 最新的（浏览器可能一次性落两个：本体 + 临时文件）。
export function pickNewest(entries) {
  if (!entries.length) return null;
  return entries.slice().sort((a, b) => b.mtimeMs - a.mtimeMs)[0];
}

// 从下载任务列表里认出新提交的那个：按名字里的时间戳取最大。
// 名字是可比较的（固定 6 位时间戳），所以取最大即可，不需要额外读页面的时间列。
export function newestTaskName(names, { exportDate } = {}) {
  const wanted = exportDate ? exportDate.replace(/-/gu, '') : null;
  const candidates = names
    .map((name) => name.trim())
    .filter((name) => PROMOTION_TASK_PATTERN.test(name))
    .filter((name) => !wanted || name.replace(/^营销场景报表_/u, '').startsWith(wanted));
  if (!candidates.length) return null;
  return candidates.slice().sort().at(-1);
}

// 统计区间必须**含**目标日：含不含是这一份工作簿能不能用的前提，不能靠「看起来对」。
export function dateWithinRange(range, date) {
  if (!Array.isArray(range) || range.length !== 2) throw new Error(`invalid range: ${JSON.stringify(range)}`);
  const [from, to] = range;
  for (const value of [from, to, date]) {
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(value ?? '')) throw new Error(`invalid date in range check: ${value}`);
  }
  return from <= date && date <= to;
}

// ---------------------------------------------------------------------------
// 点击前的「滚动到能点到 + 复核命中」两段表达式（2026-09-17 加，两次实亏换来的）
// ---------------------------------------------------------------------------
// 只写 `block:'center'` 是不够的：`inline` 会取默认的 `'nearest'`，而阿里妈妈报表页在
// 窄窗口下「下载报表」整个落在视口**右边界之外**（实测 innerWidth=1203、元素 x∈[1305,1378]）
// ⇒ `elementFromPoint(中心)` 直接返回 null，复核报 not-hit。点击本身走 JS（`el.click()`）
// 不受遮挡影响，所以那不是「点不到」，是**判据不完整**：只看了中心点一个位置。
//
// 复核的判据因此改成：**矩形内至少存在一个「在视口内且命中自己」的采样点**。
// 只看中心点会被两类现象误判，而它们都不是「按钮不可点」：
//   ① 元素在视口外（点无效，返回 null）；
//   ② 中心被常驻浮层盖住 —— 阿里妈妈右侧有 fixed 悬浮条（实测 z-index 99999、rect [1258,286,60,322]），
//      正好盖住过按钮中心。
// 失败时把 `inViewportSamples` / `blocker` 一起带出来，好判断是「视口外」还是「被谁盖住」。
export function scrollIntoViewExpression(selector) {
  // 两个方向都要居中：垂直决定是否在视口内，水平决定「右侧被截掉」时能不能带回来。
  // 取元素时只认可见的那个 —— selector 可能是被多次运行标过的（见 hitCheckExpression 的注释）。
  return `(() => {
    const matches = [...document.querySelectorAll(${JSON.stringify(selector)})];
    const el = matches.find((node) => { const r = node.getBoundingClientRect(); return r.width > 0 && r.height > 0; }) || matches[0];
    if (!el) return JSON.stringify({ ok: false, reason: 'element-missing', matches: matches.length });
    el.scrollIntoView({ block: 'center', inline: 'center' });
    return JSON.stringify({ ok: true, matches: matches.length });
  })()`;
}

export function hitCheckExpression(selector) {
  return `(() => {
    const isVisible = (node) => { const r = node.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    // 同一个 selector 可能匹配到**多个**元素：这些脚本用 data- 属性标记目标，而阿里妈妈是 hash 路由，
    // navigate 到别的子页**不会重新加载页面**，于是上一轮标过的元素留在 DOM 里。
    // querySelector 取文档序第一个 ⇒ 会拿到旧运行残留的隐藏元素，报 not-visible，
    // 却看不出「其实只是残留」（2026-09-17 实亏一次）。所以这里必须挑可见的那个。
    const matches = [...document.querySelectorAll(${JSON.stringify(selector)})];
    const el = matches.find(isVisible) || matches[0];
    if (!el) return JSON.stringify({ ok: false, reason: 'element-missing', matches: matches.length });
    const self = (node) => !!node && (node === el || el.contains(node) || node.contains(el));
    const r = el.getBoundingClientRect();
    if (!(r.width > 0 && r.height > 0)) {
      return JSON.stringify({ ok: false, reason: 'not-visible', matches: matches.length,
        rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)],
        y: Math.round(r.y), inViewport: false,
        hiddenSiblings: matches.filter((node) => !isVisible(node)).length });
    }
    const insets = [0.5, 0.25, 0.75, 0.12, 0.88];
    let inViewportSamples = 0;
    let insideSamples = 0;
    let firstHit = null;
    for (const fy of insets) {
      for (const fx of insets) {
        const x = Math.round(r.x + r.width * fx);
        const y = Math.round(r.y + r.height * fy);
        if (x < 0 || x >= window.innerWidth || y < 0 || y >= window.innerHeight) continue;
        inViewportSamples += 1;
        if (self(document.elementFromPoint(x, y))) {
          insideSamples += 1;
          if (!firstHit) firstHit = [x, y];
        }
      }
    }
    const cx = Math.round(r.x + r.width / 2);
    const cy = Math.round(r.y + r.height / 2);
    const centerInViewport = cx >= 0 && cx < window.innerWidth && cy >= 0 && cy < window.innerHeight;
    const centerPoint = centerInViewport ? document.elementFromPoint(cx, cy) : null;
    const centerIsSelf = self(centerPoint);
    return JSON.stringify({
      ok: insideSamples > 0,
      reason: insideSamples > 0 ? null : (inViewportSamples === 0 ? 'outside-viewport' : 'not-hit'),
      matches: matches.length,
      hiddenSiblings: matches.filter((node) => !isVisible(node)).length,
      y: Math.round(r.y),
      inViewport: cy >= 0 && cy < window.innerHeight,
      rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)],
      inViewportSamples, insideSamples, firstHit, centerIsSelf,
      viewport: [window.innerWidth, window.innerHeight],
      blocker: centerIsSelf ? null : (centerPoint
        ? { tag: centerPoint.tagName, cls: String(centerPoint.className).slice(0, 60) }
        : (centerInViewport ? null : 'center-outside-viewport')),
    });
  })()`;
}

// ---------------------------------------------------------------------------
// 平台自己的全屏弹窗会盖住整页：识别 + 选「关」（2026-09-19 加）
// ---------------------------------------------------------------------------
// 症状：点击前复核报 `not-hit`、`命中自己=0`、`遮挡物={"tag":"DIV","cls":""}`。
// 这不是「选择器选错了」，是**平台自己的推广引导弹窗压住了整页**，而且它**稳定复现、等不好** ——
// 与「右侧那条会自己收起的常驻浮层」是两回事（后者等一会儿重跑就过，前者等多久都没用）。
//
// 为什么必须内建、不能再靠人手工关：用户 2026-09-19 的目标是**无人值守定时跑**。
// 这个弹窗在 09-19 一天之内让盖文淘宝的补采死了两次（09:31 那次死在身份、13:xx 那次死在它），
// 每次都只能靠仓库外的临时探针手工点掉再重跑 —— 定时任务里没有「人」这一步。
//
// 两条实测教训（决定了下面为什么不写死 id、为什么要有黑名单）：
//   ① **它的 id 会变**。同一台机器、同一站点、相隔几小时：`#wrapper_dlg_982`
//      （`data-owner-id=universalBP_tool_auto_dlg`「优质计划防停投」）→ `#wrapper_dlg_925`
//      （`data-owner-id=app`）。按硬编码 id 写的探针会报「没有弹窗」然后正常退出，
//      把「点不到」的真相藏起来（本机真踩过，差点当成「已确认无遮挡」而放过）。
//      所以这里按**几何**认层：谁盖住了视口、谁在最上面。
//   ② **层里的按钮不是都该点**。925 那个层底部并排着「立即报名」和「关闭」——
//      盲点一个坐标有真实代价（报名是有对外副作用的动作）。所以候选要过**危险词黑名单**，
//      只认「关闭 / close / 取消」，其次才是右上角那个 16×16 的图标按钮。
//
// 分工：**页面表达式只负责如实采集**（层、候选、坐标），**选点在 Node 侧做纯函数**
// （`pickOverlayCloseCandidate`）—— 这样选点逻辑能被离线单测与突变验证覆盖，
// 而不是埋在 `eval` 的字符串里只能靠真跑碰运气。
export const OVERLAY_DISMISS_DANGER = /报名|开通|购买|支付|确认|提交|领取|升级|续费|立即/u;
export const OVERLAY_MIN_COVERAGE = 0.85;
export const OVERLAY_CANDIDATE_MAX_SIZE = 48;

// 采集：最上面那个盖住视口的层 + 层内「中心点命中自己」的小控件候选（可点性当场算完）。
export function overlayScanExpression(options = {}) {
  const coverage = options.coverage ?? OVERLAY_MIN_COVERAGE;
  const maxSize = options.maxSize ?? OVERLAY_CANDIDATE_MAX_SIZE;
  return `(() => {
    const vw = window.innerWidth, vh = window.innerHeight;
    const visible = (el) => {
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) === 0) return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };
    const layers = [];
    for (const el of document.querySelectorAll('body *')) {
      const cs = getComputedStyle(el);
      if (cs.position !== 'fixed' && cs.position !== 'absolute') continue;
      if (!visible(el)) continue;
      const r = el.getBoundingClientRect();
      // 「盖住视口」按面积比例判，不按 class —— 平台发版改类名不会影响这条判据。
      if (r.width < vw * ${coverage} || r.height < vh * ${coverage}) continue;
      layers.push({ el, z: cs.zIndex === 'auto' ? 0 : (parseInt(cs.zIndex, 10) || 0) });
    }
    layers.sort((a, b) => b.z - a.z);
    const top = layers[0];
    if (!top) return JSON.stringify({ blocked: false, viewport: [vw, vh], layerCount: 0 });
    const owns = (a, b) => !!a && typeof a.contains === 'function' && a.contains(b);
    const seen = new Set();
    const candidates = [];
    for (const el of top.el.querySelectorAll('button,a,div,span,i,svg,img')) {
      if (!visible(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.width > ${maxSize} || r.height > ${maxSize}) continue;
      const cx = Math.round(r.x + r.width / 2), cy = Math.round(r.y + r.height / 2);
      if (cx < 0 || cx >= vw || cy < 0 || cy >= vh) continue;
      const hit = document.elementFromPoint(cx, cy);
      if (!hit || !(hit === el || owns(el, hit) || owns(hit, el))) continue;
      // 同一个关闭控件外面套着好几层（实测一组 4 个嵌套元素落在同一坐标）⇒ 按坐标去重，
      // 否则「候选数」会被同一枚按钮灌水，选点日志也读不出重点。
      const key = [cx, cy, Math.round(r.width), Math.round(r.height)].join('|');
      if (seen.has(key)) continue;
      seen.add(key);
      candidates.push({
        tag: el.tagName, id: el.id || null,
        cls: String(el.className || '').slice(0, 60),
        text: String(el.textContent || '').trim().slice(0, 12),
        label: String(el.getAttribute('aria-label') || el.getAttribute('title') || '').slice(0, 24),
        cx, cy, w: Math.round(r.width), h: Math.round(r.height),
        atTopRight: cx > vw * 0.66 && cy < vh * 0.28,
      });
    }
    return JSON.stringify({
      blocked: true, viewport: [vw, vh], layerCount: layers.length,
      layer: {
        tag: top.el.tagName, id: top.el.id || null,
        ownerId: top.el.getAttribute('data-owner-id'),
        cls: String(top.el.className || '').slice(0, 60), z: top.z,
        rect: (() => { const r = top.el.getBoundingClientRect();
          return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)]; })(),
      },
      candidates: candidates.slice(0, 24), candidateTotal: candidates.length,
    });
  })()`;
}

// 选「关」：纯函数，离线可测。
// **不给兜底**：只在「语义上是关闭」或「位于层右上角」里选；两者都没有就返回 null（不盲点）。
// 宁可报「没找到可点的关闭控件」让人来看，也不要落到某个语义不明的小控件上 ——
// 层里那个「立即报名」就长成一个小控件。
export function pickOverlayCloseCandidate(scan, options = {}) {
  const danger = options.danger ?? OVERLAY_DISMISS_DANGER;
  if (!scan || scan.blocked !== true || !Array.isArray(scan.candidates)) return null;
  const safe = scan.candidates.filter((c) => !danger.test(`${c.text || ''} ${c.label || ''} ${c.cls || ''}`));
  const named = safe.filter((c) => /关闭|close|取消/iu.test(`${c.text || ''} ${c.label || ''}`));
  const icon = safe.filter((c) => c.atTopRight === true).sort((a, b) => (a.cy - b.cy) || (b.cx - a.cx));
  const pick = named[0] ?? icon[0] ?? null;
  if (!pick) return null;
  return {
    pick,
    // 把「排除了谁」一起带回去：日志里要能看出「没点那个『立即报名』是判据做的，不是碰巧」。
    excluded: scan.candidates.filter((c) => danger.test(`${c.text || ''} ${c.label || ''} ${c.cls || ''}`))
      .map((c) => c.text || c.label || c.cls),
    namedCount: named.length,
  };
}

// 关完**回读**（HTTP 200 / `clicked:true` 都证明不了任何事）：全屏层还在不在 + 目标还能不能点到。
export function overlayAfterExpression(selector = null) {
  return `(() => {
    const vw = window.innerWidth, vh = window.innerHeight;
    const remainingLayers = [];
    for (const el of document.querySelectorAll('body *')) {
      const cs = getComputedStyle(el);
      if (cs.position !== 'fixed' && cs.position !== 'absolute') continue;
      if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) === 0) continue;
      const r = el.getBoundingClientRect();
      if (r.width < vw * ${OVERLAY_MIN_COVERAGE} || r.height < vh * ${OVERLAY_MIN_COVERAGE}) continue;
      remainingLayers.push(el.tagName + (el.id ? '#' + el.id : '') + ' z=' + cs.zIndex);
    }
    const selector = ${JSON.stringify(selector)};
    let targetHit = null;
    if (selector) {
      const isVisible = (node) => { const r = node.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
      const matches = [...document.querySelectorAll(selector)];
      const el = matches.find(isVisible) || matches[0] || null;
      if (el) {
        const r = el.getBoundingClientRect();
        const owns = (a, b) => !!a && typeof a.contains === 'function' && a.contains(b);
        const hit = document.elementFromPoint(Math.round(r.x + r.width / 2), Math.round(r.y + r.height / 2));
        targetHit = !!hit && (hit === el || owns(el, hit) || owns(hit, el));
      }
    }
    return JSON.stringify({ remainingLayers, targetHit });
  })()`;
}

// 关遮挡这一步的措辞：成功与失败都要能自答「检出的是哪一层、候选几个、排除了谁」，
// 否则下次还得手工复现一遍才知道卡在哪。
export function describeOverlayScan(scan, picked) {
  if (!scan || scan.blocked !== true) return '没有检出盖住整页的全屏层（遮挡物不是这一类）';
  const layer = scan.layer ?? {};
  const parts = [`全屏层 ${layer.tag}${layer.id ? `#${layer.id}` : ''}`
    + `${layer.ownerId ? `(data-owner-id=${layer.ownerId})` : ''} z=${layer.z}`];
  if (layer.rect) parts.push(`rect=${JSON.stringify(layer.rect)}`);
  parts.push(`层内可点小控件 ${scan.candidates?.length ?? 0}/${scan.candidateTotal ?? 0} 个`);
  if (picked) {
    const target = picked.pick;
    parts.push(`选中 ${target.tag}${target.id ? `#${target.id}` : ''}`
      + `「${target.text || target.label || target.cls}」于 (${target.cx},${target.cy})`);
    if (picked.excluded?.length) parts.push(`已按黑名单排除 ${JSON.stringify(picked.excluded)}`);
  } else {
    parts.push('没找到可安全点击的关闭控件（不盲点，交给人处理）');
  }
  return parts.join('，');
}

// 把「扫 → 选 → 点 → 回读」串成一步，**依赖注入**（`evalOn` / `clickPoint` / `delay` / `log`）。
// 为什么做成工厂而不是在各脚本里各写一遍：两个采集脚本（生意参谋侧、阿里妈妈侧）都要用它，
// 而且「关不掉时不许改变主流程的失败方向」这条编排约束必须**离线可测** —— 注入以后就能用假实现
// 直接断言这条约束，不必等真跑到一次遮挡。
// 注入函数的形状统一是 `(args, targetId, payload)`；返回的 dismisser 形状是 `(args, targetId, selector)`。
export function createOverlayDismisser({ evalOn, clickPoint, delay, log = () => {}, settleMs = 2500 } = {}) {
  for (const [name, fn] of Object.entries({ evalOn, clickPoint, delay })) {
    if (typeof fn !== 'function') throw new Error(`createOverlayDismisser 缺少注入实现：${name}`);
  }
  return async function dismissBlockingOverlay(args, targetId, selector = null) {
    const scan = await evalOn(args, targetId, overlayScanExpression());
    // 没检出这一类遮挡就**原样返回 false**：调用方照旧按原来的措辞报错，
    // 不能因为多了这一步就把「点不到」错报成「弹窗导致的」。
    if (!scan || scan.blocked !== true) return { attempted: false, reason: 'not-a-fullscreen-overlay' };
    const picked = pickOverlayCloseCandidate(scan);
    log(`[遮挡] ${describeOverlayScan(scan, picked)}`);
    if (!picked) return { attempted: true, dismissed: false, reason: 'no-safe-candidate', scan, picked: null };
    // 真实鼠标点击（这一族页面 JS 点击常无效）。点这一步自身失败也不该把整轮带走 ⇒ 吞掉异常，
    // 让下面的**回读**去下结论（回读说没关掉就是没关掉）。
    await clickPoint(args, targetId, [picked.pick.cx, picked.pick.cy]).catch(() => '');
    await delay(settleMs);
    const after = await evalOn(args, targetId, overlayAfterExpression(selector));
    const dismissed = after.remainingLayers.length === 0;
    log(`[遮挡] 关后回读：全屏层剩 ${after.remainingLayers.length} 个`
      + `${after.remainingLayers.length ? `（${JSON.stringify(after.remainingLayers)}）` : ''}`
      + `｜目标可点=${after.targetHit} ⇒ ${dismissed ? '已关掉' : '没关掉'}`);
    return { attempted: true, dismissed, remainingLayers: after.remainingLayers,
      targetHit: after.targetHit, scan, picked };
  };
}

// 把「关遮挡那一步试出了什么」变成报错里的一句人话（两个脚本共用）。
// 没试过（`attempted !== true`）时说清「这次失败与全屏弹窗无关」——
// 免得下一次看到同类报错时，把「其实是选择器/坐标问题」误判成「又是弹窗」。
export function describeOverlayAttempt(attempt) {
  if (!attempt || attempt.attempted !== true) return '（复核失败与全屏弹窗无关）';
  const detail = describeOverlayScan(attempt.scan, attempt.picked);
  return attempt.dismissed
    ? `（遮挡层已关掉：${detail}；但复核仍不过，说明这次不是它挡的）`
    : `（检出了全屏遮挡层但没能关掉：${detail}）`;
}

// ---------------------------------------------------------------------------
// 「这一屏到底是哪家店」——采集段的两道身份判据（2026-09-18 加）
// ---------------------------------------------------------------------------
// 为什么必须加：用户 2026-09-18 质问「为什么万象台跟生意参谋不一样，绝对不能串数据」。
// 查清的结果是**两个站点显示的本来就不是同一种东西**：
//   · 阿里妈妈页头只显示**登录会员名 + 会员ID**（实测「随心品质定制:阿彦 ID：887360146」），
//     从头到尾**不显示店铺名**；
//   · 生意参谋页头显示**店铺名 + 主店/子店**（实测「盖文全卫定制 主店」）。
// 会员名与店铺名本来就可以不同名，所以「两边不一样」不构成串店 —— 但也因此，
// **只看页面文字无法证明这两屏属于同一家店**。所以身份必须逐站点各自取、各自与期望值比对。
//
// 而当时的两个采集脚本**一次身份都没核对过**（只有询单回填那一步核对了店铺名），
// 两个产物里还只有一个带身份：生意参谋的日报 xlsx 有「店铺名称」列，
// 阿里妈妈的营销场景报表 CSV **一个店铺身份字段都没有**。
// 于是「取错窗口」在推广这一步是**静默的**：文件照样落盘、数字照样进飞书。
// 这两道判据就是把那个静默口子堵上：给定期望值时，页面身份对不上就停手。
//
// 表达式只读、不点任何控件。取法都按**文本形状**取，不写死带哈希的类名（发版就会变）：
//   · 生意参谋：取「以 主店/子店 结尾、且最短」的那段文本（最短 = 最内层，避免把外层容器
//     连「生意参谋 惠商 我的 帮助 退出」一起吃进来）；店铺名 = 去掉尾部的主店/子店。
//   · 阿里妈妈：必须把「`主账号:子账号` + ID：数字」**连在一起**认。只认 `xx:yy` 会命中
//     页面上的时间串（实测 memberHits 里出现过 00:00、01:00 这种），那会把身份读成时间。
export function sycmShopIdentityExpression() {
  return `(() => {
    const clean = (value) => String(value == null ? '' : value).replace(/\\s+/g, ' ').trim();
    const matches = [...document.querySelectorAll('a,div,span')]
      .map((el) => clean(el.innerText))
      .filter((text) => /^.{1,30}?(?:主店|子店)$/.test(text));
    // 取最短的那段：外层容器会带上前缀（「生意参谋 xxx 主店」），最短的才是页头那一块。
    const text = matches.slice().sort((a, b) => a.length - b.length)[0] ?? null;
    const parsed = text ? text.match(/^(.*?)\\s*(主店|子店)$/) : null;
    return JSON.stringify({
      href: location.href,
      raw: text,
      candidates: matches.slice(0, 6),
      shopName: parsed ? parsed[1] : null,
      nodeType: parsed ? parsed[2] : null,
    });
  })()`;
}

export function alimamaIdentityExpression() {
  return `(() => {
    const body = document.body.innerText.replace(/\\s+/g, ' ');
    const parsed = body.match(/([\\u4e00-\\u9fa5A-Za-z0-9_]{2,20}):([\\u4e00-\\u9fa5A-Za-z0-9_]{1,20})\\s*ID\\s*[:：]\\s*(\\d{6,})/);
    return JSON.stringify({
      href: location.href,
      memberName: parsed ? parsed[1] + ':' + parsed[2] : null,
      memberId: parsed ? parsed[3] : null,
      raw: parsed ? parsed[0] : null,
    });
  })()`;
}

export function normalizeShopName(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

// 身份核对：**fail-closed**。expected 为空 = 调用方没给期望值 ⇒ 不拦（脚本仍会打印实际读到什么，
// 因为「记录但不拦」和「看起来核对了」是两件事，日志里必须看得出是哪一种）。
// 读不到身份**也算失败**：身份未知就等于没核对过，继续点下载就是碰运气。
export function assertShopIdentity({ expected, observed, label = '店铺' } = {}) {
  const got = normalizeShopName(observed);
  if (!expected) return { checked: false, observed: got };
  const want = normalizeShopName(expected);
  if (!want) throw new Error(`${label}期望值只给了空白字符，等于没给`);
  if (!got) {
    throw new Error(`${label}身份读不到（期望「${want}」）：拒绝在身份未知的页面上继续`
      + ' —— 读到的原文在上面那行日志里，先确认窗口/代理对不对再说');
  }
  if (got !== want) {
    throw new Error(`${label}身份对不上：期望「${want}」，页面实际「${got}」`
      + ' —— 这就是一次串店，已停手。别在这个页面上点下载：文件会照样落盘、数字会照样进飞书，'
      + '而且（推广报表那一侧）产物里连店铺身份字段都没有，事后查不出来。');
  }
  return { checked: true, expected: want, observed: got };
}

// 阿里妈妈侧的核对对象是**会员名（＋会员ID）**，不是店铺名 —— 那一页根本没有店铺名。
// 这两件事必须分开做：把会员名当店名比对，正是这次被用户问住的那个混淆。
export function assertMemberIdentity({ expectedName, expectedId, observed } = {}) {
  if (!expectedName && !expectedId) {
    return { checked: false, observedName: normalizeShopName(observed?.memberName) };
  }
  const results = [];
  if (expectedName) {
    results.push(assertShopIdentity({ expected: expectedName, observed: observed?.memberName,
      label: '阿里妈妈会员名' }));
  }
  if (expectedId) {
    const wantId = String(expectedId).trim();
    if (!/^\d{6,}$/u.test(wantId)) throw new Error(`会员 ID 期望值必须是 6 位以上数字，收到 ${JSON.stringify(expectedId)}`);
    const gotId = String(observed?.memberId ?? '').trim();
    if (gotId !== wantId) {
      throw new Error(`阿里妈妈会员 ID 对不上：期望 ${wantId}，页面实际 ${gotId || '（读不到）'}`
        + ' —— 会员名可能被改过，ID 不会；两者都对上才算同一个登录。');
    }
    results.push({ checked: true, expected: wantId, observed: gotId });
  }
  return { checked: true, results };
}

// ---------------------------------------------------------------------------
// 阿里妈妈「下载任务管理」取件的三段表达式（2026-09-17 改；此前那版模型是错的）
// ---------------------------------------------------------------------------
// 这一页的真实结构，逐条实测得来，别再按直觉推：
//   · 任务列表是「任务行 tr + 紧跟一行操作行 tr」**交替**；操作行里放着「下载 / 导入超级表格 / AI分析 / 删除」。
//   · **操作行默认 `display:none`**。任何时刻页面上可见的「下载」叶子**恰好 1 个** ——
//     实测 8 个任务行对应 8 个叶子，7 个 rect 全 [0,0,0,0]。
//   · 让某一行激活（从而让它的操作行显形）的可靠动作是**真实鼠标点击该行的复选框**，
//     点完必须**回读** `checked===true` 才算数。
//   · 因此「底部操作栏」这个说法是错的（我曾据此写过一版）：那个位置上的按钮，其实就是
//     当时恰好激活的那一行的操作行按钮 —— 行内与底部是同一套东西的两个投影，不是两条路。
//   · **必须在点击前当场重新量矩形**：实测复核时报 y=350，下一秒按钮已在 y=391（差整一行 41px）；
//     拿旧坐标去点会静默落空 —— 落在相邻任务的单元格上，`clicked:true` 却什么都不发生。
//   · 零尺寸矩形一律 fail-closed：曾拿一个 rect 全零的元素的「中心」(0,0) 去点，正好点在页面
//     左上角，把阿里妈妈页从「下载任务管理」导航到了「首页」（一次探针事故，非站点问题）。
//   · **激活态会自行衰减**：实测激活后隔 15 秒再看，那个入口已经回到 rect [0,0,0,0]（操作行又隐藏了）。
//     所以定位与点击之间只允许隔一次网络往返 —— 「量完先去干点别的再回来点」在这里必然落空。
//   · 顺带钉死一条：同一次干净对照里，对**同一个正确元素**发 JS 的 `el.click()` 等了 15 秒
//     没有任何文件落盘，改真实鼠标点中心 3 秒落盘 ⇒ 取件这一下必须走真实鼠标事件，别退回 JS 点击。
export const TASK_DOWNLOAD_MARK = 'data-collect-task-download';

// 目标任务行：文件名 + 它的复选框坐标 + 当前勾选态。是「激活该行」的输入。
export function targetRowExpression(taskName) {
  return `(() => {
    const isVisible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const rows = [...document.querySelectorAll('tr')];
    const names = [...document.querySelectorAll('*')]
      .filter((el) => el.children.length === 0 && el.textContent.trim() === ${JSON.stringify(taskName)} && isVisible(el));
    if (!names.length) return JSON.stringify({ found: false, reason: 'task-row-missing' });
    const tr = names[0].closest('tr');
    if (!tr) return JSON.stringify({ found: false, reason: 'no-row' });
    const box = tr.querySelector('input[type=checkbox]');
    const r = box ? box.getBoundingClientRect() : null;
    const center = r ? [Math.round(r.x + r.width / 2), Math.round(r.y + r.height / 2)] : null;
    // 「量到坐标」不等于「点得到」（2026-09-17 实测）：页面上有个 z-index 999999 的浮层正好压住第一行，
    // 中心点命中的是浮层里的 TD，真实点击落在浮层上、复选框纹丝不动 —— 而这一页「点错不报错」。
    // 所以顺手把「那一点到底是谁」带出来；同一次往返内算完，不给激活态衰减留时间。
    const canHit = typeof document.elementFromPoint === 'function';
    const hit = (canHit && center) ? document.elementFromPoint(center[0], center[1]) : null;
    // contains 存在性也要判：真实元素都有，但这一步是在**别人家的页面**里 eval 的，
    // 万一拿到个没有 contains 的东西，宁可判成「不是它」（⇒ 走重试，不硬点），也不要让整步炸掉。
    const owns = (a, b) => !!a && typeof a.contains === 'function' && a.contains(b);
    const boxHit = (box && hit) ? (hit === box || owns(box, hit) || owns(hit, box)) : null;
    return JSON.stringify({
      found: true,
      trIndex: rows.indexOf(tr),
      hasCheckbox: !!box,
      checked: box ? box.checked : null,
      checkboxRect: r ? [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)] : null,
      checkboxCenter: center,
      checkboxHit: boxHit,
      checkboxHitTag: hit ? hit.tagName : null,
      checkboxHitClass: hit ? String(hit.className || '').slice(0, 48) : null,
      rowText: tr.innerText.replace(/\\s+/g, ' ').trim().slice(0, 120),
    });
  })()`;
}

// 取件入口：只认**目标任务行的下一行**（它的操作行）里那个可见的「下载」。
// 不再全页扫「第一个可见的下载」——那样会点到别的任务行的入口，而在这一页上「点错也不知道」。
export function downloadEntryExpression(taskName) {
  return `(() => {
    const isVisible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    // 先清掉上一轮的标记：阿里妈妈是 hash 路由，navigate 到别的子页**不重载页面**，旧标记会留在 DOM 里。
    document.querySelectorAll('[${TASK_DOWNLOAD_MARK}]').forEach((el) => el.removeAttribute('${TASK_DOWNLOAD_MARK}'));
    const rows = [...document.querySelectorAll('tr')];
    const names = [...document.querySelectorAll('*')]
      .filter((el) => el.children.length === 0 && el.textContent.trim() === ${JSON.stringify(taskName)} && isVisible(el));
    if (!names.length) return JSON.stringify({ ok: false, reason: 'task-row-missing' });
    const tr = names[0].closest('tr');
    const actionTr = tr.nextElementSibling;
    if (!actionTr) return JSON.stringify({ ok: false, reason: 'no-action-row' });
    const leaves = [...actionTr.querySelectorAll('*')]
      .filter((el) => el.children.length === 0 && el.textContent.trim() === '下载');
    const entry = leaves.find(isVisible);
    if (!entry) {
      return JSON.stringify({ ok: false, reason: 'action-row-hidden',
        actionTrIndex: rows.indexOf(actionTr),
        actionRowDisplay: getComputedStyle(actionTr).display,
        leavesInActionRow: leaves.length,
        actionRowText: (actionTr.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 60),
        taskRowText: tr.innerText.replace(/\\s+/g, ' ').trim().slice(0, 120) });
    }
    const target = entry.closest('button') || entry;
    target.setAttribute('${TASK_DOWNLOAD_MARK}', '1');
    const r = target.getBoundingClientRect();
    if (!(r.width > 0 && r.height > 0)) {
      return JSON.stringify({ ok: false, reason: 'zero-size',
        rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)] });
    }
    const cx = Math.round(r.x + r.width / 2);
    const cy = Math.round(r.y + r.height / 2);
    const visibleDownloads = [...document.querySelectorAll('*')]
      .filter((el) => el.children.length === 0 && el.textContent.trim() === '下载' && isVisible(el));
    return JSON.stringify({
      ok: true,
      actionTrIndex: rows.indexOf(actionTr),
      rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)],
      center: [cx, cy],
      inViewport: cx >= 0 && cx < window.innerWidth && cy >= 0 && cy < window.innerHeight,
      viewport: [window.innerWidth, window.innerHeight],
      leavesInActionRow: leaves.length,
      visibleDownloads: visibleDownloads.length,
    });
  })()`;
}

// 勾选集（下标）—— 用来在动手前记一份、在排练结束时恢复。
export function checkboxStateExpression() {
  return `JSON.stringify({
    checked: [...document.querySelectorAll('input[type=checkbox]')]
      .map((box, index) => (box.checked ? index : -1)).filter((index) => index >= 0),
    total: document.querySelectorAll('input[type=checkbox]').length,
  })`;
}

// 把勾选集恢复成给定的样子。`--locate-only` 用：排练要走到「选中目标任务行」这一步
// （不然操作行不显形，排练就成了「排练通过、真跑失败」），但排练结束必须把状态还回去。
export function restoreCheckboxesExpression(checkedIndexes) {
  return `(() => {
    const want = new Set(${JSON.stringify(checkedIndexes)});
    let changed = 0;
    [...document.querySelectorAll('input[type=checkbox]')].forEach((box, index) => {
      if (box.checked !== want.has(index)) { box.click(); changed += 1; }
    });
    return JSON.stringify({ changed,
      checked: [...document.querySelectorAll('input[type=checkbox]')]
        .map((box, index) => (box.checked ? index : -1)).filter((index) => index >= 0) });
  })()`;
}

// 入口定位失败的措辞。要说清「是文件名那行没找到、还是它的操作行没显形、还是显形了但零尺寸」，
// 否则只能重新手工复现一次才知道卡在哪一步。
export function describeEntryMiss(entry) {
  const parts = [String(entry.reason)];
  if (entry.actionTrIndex !== undefined) parts.push(`操作行=第 ${entry.actionTrIndex} 行`);
  if (entry.actionRowDisplay) parts.push(`操作行 display=${entry.actionRowDisplay}`);
  if (entry.leavesInActionRow !== undefined) parts.push(`操作行内「下载」叶子=${entry.leavesInActionRow}`);
  if (entry.actionRowText) parts.push(`操作行文本=${JSON.stringify(entry.actionRowText)}`);
  if (entry.rect) parts.push(`rect=${JSON.stringify(entry.rect)}`);
  return parts.join('，');
}

// 复核结果的措辞（也集中在这里，免得两个采集脚本各写一份、越写越不一样）。
// 失败要能自答「是视口外，还是被谁盖住」，否则只能重新手工复现一次才知道卡在哪。
export function describeHitMiss(hit) {
  const parts = [String(hit.reason), `y=${hit.y}`, `视口内=${hit.inViewport}`];
  parts.push(`视口内采样=${hit.inViewportSamples}/25`, `命中自己=${hit.insideSamples}`);
  if (hit.rect) parts.push(`rect=${JSON.stringify(hit.rect)}`);
  if (hit.viewport) parts.push(`视口=${JSON.stringify(hit.viewport)}`);
  if (hit.blocker) parts.push(`遮挡物=${JSON.stringify(hit.blocker)}`);
  return parts.join('，');
}

// 通过时也说清「凭什么算通过」：中心点，还是退让到别的采样点。
export function describeHitPass(hit) {
  return hit.centerIsSelf
    ? `y=${hit.y}（中心点命中）`
    : `y=${hit.y}（中心点被 ${JSON.stringify(hit.blocker)} 盖住，改用采样点 ${JSON.stringify(hit.firstHit)}）`;
}

// 采集段的参数解析。两个脚本共用，差别只在有没有 `--phase`。
//
// 2026-09-18 加三个**身份期望值**参数（都可不给）：
//   `--expect-shop`      生意参谋页头的店铺名（如「盖文全卫定制」）
//   `--expect-member`    阿里妈妈页头的会员名（如「随心品质定制:阿彦」）
//   `--expect-member-id` 阿里妈妈页头的会员数字 ID（如 887360146）
// 为什么是两个参数而不是一个「店名」：这两个名字**本来就不是同一种东西**（会员名 vs 店铺名），
// 而且阿里妈妈那一页压根不显示店铺名。合成一个参数就会逼着调用方去猜哪个站点该填哪个名字，
// 猜错的形态正是用户这次问到的那件事。
export function parseCollectArgs(argv, options = {}) {
  const args = { date: null, downloads: null, proxy: null, task: null, phase: null,
    expectShop: null, expectMember: null, expectMemberId: null,
    timeoutMs: options.timeoutMs ?? 30000, reportId: options.reportId ?? null,
    // 等阿里妈妈把推广报表「生成成功」的预算。**与 timeoutMs 分开**：timeoutMs 是「点了下载之后
    // 等文件落盘」，这个是「平台自己在生成」；一个开关管两件事正是本项目已经栽过的形态。
    // 默认 11 分钟的依据是平台自己的提示语：「数据量大时最长 10 分钟」（见 submit 段那行日志）。
    generationWaitMs: options.generationWaitMs ?? 660000,
    // 勾选目标任务行的重试次数：留给「被浮层挡一下」这类可自愈的遮挡
    // （2026-09-17 实测：z-index 999999 的浮层压住第一行，浮层自己收起后重试即过）。
    selectAttempts: options.selectAttempts ?? 6 };
  const allowed = new Set(options.flags ?? []);
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    const next = () => {
      const value = argv[++index];
      if (value === undefined) throw new Error(`${key} requires a value`);
      return value;
    };
    if (key === '--date') args.date = next();
    else if (key === '--downloads') args.downloads = next();
    else if (key === '--proxy') args.proxy = next();
    else if (key === '--task') args.task = next();
    else if (key === '--phase') args.phase = next();
    else if (key === '--timeout-ms') args.timeoutMs = Number(next());
    else if (key === '--generation-wait-ms') args.generationWaitMs = Number(next());
    else if (key === '--report-id') args.reportId = next();
    else if (key === '--expect-shop') args.expectShop = next();
    else if (key === '--expect-member') args.expectMember = next();
    else if (key === '--expect-member-id') args.expectMemberId = next();
    // 布尔开关：`--locate-only` → args.locateOnly。带横线的名字一律转小驼峰，
    // 免得调用方去猜 `args['locate-only']` 还是 `args.locate_only`。
    else if (allowed.has(key)) {
      const name = key.replace(/^--/u, '').replace(/-([a-z])/gu, (_, letter) => letter.toUpperCase());
      args[name] = true;
    } else throw new Error(`unknown argument: ${key}`);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(args.date ?? '')) throw new Error('missing or invalid --date (expected YYYY-MM-DD)');
  if (!Number.isInteger(args.timeoutMs) || args.timeoutMs <= 0) throw new Error('--timeout-ms must be a positive integer');
  if (!Number.isInteger(args.generationWaitMs) || args.generationWaitMs <= 0) {
    throw new Error('--generation-wait-ms must be a positive integer');
  }
  // 身份期望值写错要**在这里**就炸，而不是等看清了页面、点完下载才炸 —— 那时候坑已经踩了。
  if (args.expectShop !== null && !normalizeShopName(args.expectShop)) {
    throw new Error('--expect-shop must not be blank');
  }
  if (args.expectMember !== null && !normalizeShopName(args.expectMember)) {
    throw new Error('--expect-member must not be blank');
  }
  if (args.expectMemberId !== null && !/^\d{6,}$/u.test(String(args.expectMemberId).trim())) {
    throw new Error('--expect-member-id must be 6+ digits (e.g. 887360146)');
  }
  if (options.phases) {
    if (!options.phases.includes(args.phase)) {
      throw new Error(`--phase must be one of ${options.phases.join('|')} (got ${JSON.stringify(args.phase)})`);
    }
  } else if (args.phase !== null) {
    throw new Error('this script does not take --phase');
  }
  return args;
}
