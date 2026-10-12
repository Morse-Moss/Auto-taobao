/**
 * 失败现场的「感知层」：某一步失败时，把**页面当时长什么样**落成可读的事实。
 *
 * 为什么需要它（2026-09-28 第一性原理分析）：
 *   这条链失败时给的是**符号**（`action-row-hidden`、`sycm tab did not activate`），
 *   而不是**事实**（页面此刻的 DOM、可见文本、关键元素的位置）。符号对不上事实，
 *   人就只能靠多轮对话去猜 —— 这正是「每天要跑通都得对话好几轮」的成本来源。
 *   这个模块的唯一职责：**把符号翻译成事实并落盘**，让下一次诊断不必再靠对话补。
 *
 * 三条纪律（与 `recoverFailedShop` 同一个立场）：
 *   1) **绝不吞掉原来那个错**：本模块自己 try 住一切，永远返回对象、永不抛。
 *      感知失败是「学不到」，不是「又出错了」—— 绝不能盖掉主线失败原因。
 *   2) **感知失败也要留痕**：每一项都记 `ok` / `error`，读不到就写读不到，
 *      不许静默变成空对象（那会让「没抓到」和「页面真的空」长得一样）。
 *   3) **纯函数 + 依赖注入**：真机才有代理，而三个分支（都成功、部分失败、全失败）
 *      必须能在离线里断言到。这是本仓 `recoverFailedShop` / `settleSlots` 的既有做法。
 *
 * 产物（写进该店的证据目录）：
 *   - `98-failure-state.json`：结构化事实（页面 URL、可见文本、关键元素矩形、DOM 摘要）
 *   - `98-failure-page.png`  ：失败页面的截图（截图失败只降级，不影响 JSON）
 *
 * 注意：本模块**不改任何既有失败语义**。它只在「已经确定失败」之后被调用一次，
 * 追加两个产物文件，不写 `failedStage`、不改退出码、不进告警文案。
 *
 * 2026-10-12 补第四条纪律（同一立场，来自真实现场）：
 *   4) **拍对页**。取哪个页签不是细节 —— 店铺实例的第一个非 `about:` 页签是**店铺标识页**
 *      （`runtime/shop-window-label.html`），于是 `promotion-fetch` 失败时采到的会是那一页：
 *      现场文件在、`ok:true`、内容却与出事的那一页无关（实证见
 *      `evidence/batches-2026-10-10/b1/里可林淘宝/98-failure-state.txt` 的 URL）。
 *      「没人查」从来不是这类缺陷拖着的理由，是**采错了页**。现在按调用方给的站点提示取页
 *      （`pickFailureTarget`），取不到才退回历史行为，并把「这一页是怎么选中的」写进产物。
 */
import { siteAdapter } from './date-picker.mjs';
import { pagesMatching } from '../../../runtime/target-url-match.mjs';

/**
 * 在页面里取「失败现场」的 JS 表达式。
 *
 * 取什么、为什么取这些：
 *   - `title` / `url`：先钉住「这是哪一页」—— 很多误判源于看错了页面。
 *   - `visibleText`：页面上人眼能看到的话（截断）。登录墙、报错弹窗、空列表
 *     全在这里显形，这是符号 → 事实最直接的一步。
 *   - `dialogs` / `masks`：全屏遮挡层的历史名号（`wrapper_dlg_*` 一族）。
 *     本项目多次栽在这上面，必须在失败现场直接点名它「在不在、多大、z 多少」。
 *   - `viewport`：视口尺寸。冷启动小窗导致「按钮在视口外」是本项目的已知形态，
 *     失败现场必须带这个数，否则又得靠猜。
 *   - `interactive`：可见的按钮/链接的文本与矩形（截断、限量）。
 *     「入口在哪」这个问题的答案就在这里面 —— 它把 `action-row-hidden`
 *     从「找不到」变成「这些是页面上现在能点的东西」。
 *   - `domSummary`：标签计数 + 主容器链。用于回答「结构变了没有」。
 *   - `tables`：表格的尺寸（行×列）。「操作行 display:none」这类判断依赖它。
 *
 * 全部包在 try 里：页面任何一处结构异常都不该让整个表达式中断，
 * 取不到的那一项退化成 null，其余照常返回。
 */
export const FAILURE_STATE_EXPRESSION = `(() => {
  const safe = (fn, fallback = null) => { try { return fn(); } catch { return fallback; } };
  const txt = (el) => (el && el.innerText ? String(el.innerText) : '').replace(/\\s+/g, ' ').trim();
  const rectOf = (el) => safe(() => {
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
  });
  const visible = (el) => safe(() => {
    if (!el) return false;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }, false);

  const viewport = {
    w: window.innerWidth, h: window.innerHeight,
    dpr: window.devicePixelRatio, scrollY: Math.round(window.scrollY),
  };

  const dialogs = safe(() => Array.from(document.querySelectorAll(
    '[class*="dialog"], [class*="wrapper_dlg"], [class*="mask"], [class*="overlay"], [role="dialog"]'
  )).filter(visible).slice(0, 12).map((el) => ({
    tag: el.tagName, id: el.id || null,
    cls: String(el.className || '').slice(0, 120),
    z: safe(() => getComputedStyle(el).zIndex) || null,
    rect: rectOf(el),
    text: txt(el).slice(0, 160),
  })), []);

  const interactive = safe(() => Array.from(document.querySelectorAll(
    'button, a, [role="button"], input[type="submit"], [class*="btn"], [class*="Btn"]'
  )).filter(visible).slice(0, 40).map((el) => ({
    tag: el.tagName, id: el.id || null,
    text: (txt(el) || el.getAttribute('value') || el.getAttribute('title') || '').slice(0, 60),
    cls: String(el.className || '').slice(0, 80),
    rect: rectOf(el),
  })), []);

  const domSummary = safe(() => {
    const counts = {};
    for (const tag of document.querySelectorAll('*')) {
      counts[tag.tagName] = (counts[tag.tagName] || 0) + 1;
    }
    const containers = Array.from(document.querySelectorAll(
      'div[id], main, [class*="container"], [class*="content"], [class*="wrapper"]'
    )).slice(0, 10).map((el) => ({
      tag: el.tagName, id: el.id || null,
      cls: String(el.className || '').slice(0, 80), rect: rectOf(el),
    }));
    return { totalElements: document.querySelectorAll('*').length, counts, containers };
  }, null);

  const tables = safe(() => Array.from(document.querySelectorAll('table')).slice(0, 8).map((el) => {
    const rows = el.querySelectorAll('tbody tr');
    return { rows: rows.length, cols: safe(() => (el.querySelector('tr') ? el.querySelector('tr').children.length : 0), 0),
      rect: rectOf(el), visible: visible(el) };
  }), []);

  return {
    capturedAt: new Date().toISOString(),
    url: location.href,
    title: document.title,
    viewport,
    visibleText: safe(() => (document.body ? document.body.innerText : '')).replace(/\\s+/g, ' ').trim().slice(0, 3000),
    dialogs, interactive, domSummary, tables,
  };
})()`;

/**
 * 把 `/eval` 的返回剥成「表达式真正的返回值」。
 *
 * 为什么必须有这一层（2026-10-05 第四次踩；这次代价＝现场产物一直是空壳）：
 * 代理的 `/eval` 回的是 **`{ value: <表达式返回值> }`**（CDP `Runtime.evaluate` 的形状）——
 * 仓库里既有调用点一直写着 `.value`（`runtime/feishu-ui-field-menu.mjs` 等），这里漏了。
 * 原先只判 `typeof raw === 'string'`：拿到对象就**直接当成 state 用** ⇒ 落盘的 JSON 变成
 * `{"value":"{…真现场…}"}`、人读版每一栏都是 `?` 与空串 ⇒
 * **「采到了」与「采空了」长得一模一样**，而这个模块存在的全部理由就是把符号翻成事实。
 * 更坏的是它**不报错**：`ok:true`、两份产物都在，只是内容没意义 —— 谁都不会去查。
 *
 * 剥法：`{value}` 允许套多层（代理包装、将来再包一层都不慌）；中途遇到字符串就按 JSON 解析一次
 * （表达式自己 `JSON.stringify` 过）；解析不动就把它当最终值返回，由调用点判形状。
 */
export function unwrapEvalValue(raw, { maxDepth = 4 } = {}) {
  let current = raw;
  for (let depth = 0; depth < maxDepth; depth += 1) {
    if (typeof current === 'string') {
      try {
        current = JSON.parse(current);
      } catch {
        return current; // 不是 JSON ⇒ 它就是最终值（调用点会判它是不是对象）
      }
      continue;
    }
    if (current && typeof current === 'object' && !Array.isArray(current)
      && Object.keys(current).length === 1 && 'value' in current) {
      current = current.value;
      continue;
    }
    return current;
  }
  return current;
}

/**
 * 把一次「取现场」的结果渲染成人读的文本，写进 `98-failure-state.txt`。
 *
 * 为什么要人读版：JSON 是给下一次执行/agent 用的，txt 是给人巡场时 30 秒看懂的。
 * 两者都要，缺一个就还得靠对话补。
 */
export function renderFailureStateText(state, { shopKey = null, stage = null, error = null, selected = null } = {}) {
  if (!state) return '(没能取到页面现场)\n';
  const lines = [];
  lines.push(`店：${shopKey ?? '?'}`);
  lines.push(`停在哪一步：${stage ?? '?'}`);
  lines.push(`失败原因（符号）：${error ?? '?'}`);
  lines.push(`页面：${state.title ?? '?'}`);
  lines.push(`URL：${state.url ?? '?'}`);
  // 「这一页是怎么选中的」必须写在人读版里：2026-10-12 之前这里只会印 URL，
  // 而 URL 是店铺标识页时，读的人无从知道「拍错页了」—— 只能以为出事的那一页长这样。
  if (selected) {
    const how = selected.how === 'pageHint'
      ? `按站点提示「${selected.pageHint}」选中（片段 ${selected.fragment}）`
      : selected.how === 'firstNonAboutPage'
        ? `第一个非 about 页签${selected.fragment ? `（给了提示「${selected.pageHint}」但没挑到该站点的页）` : ''}`
        : '没选到页签';
    lines.push(`现场页签：${how}`);
  } else {
    lines.push('现场页签：（没记）');
  }
  if (state.viewport) {
    lines.push(`视口：${state.viewport.w}x${state.viewport.h}（dpr=${state.viewport.dpr}，滚动=${state.viewport.scrollY}）`);
  }
  if (state.dialogs?.length) {
    lines.push(`遮挡层（${state.dialogs.length} 个仍可见）：`);
    for (const d of state.dialogs) {
      lines.push(`  · ${d.tag}${d.id ? `#${d.id}` : ''} z=${d.z ?? '?'} `
        + `rect=${d.rect ? `${d.rect.x},${d.rect.y},${d.rect.w}x${d.rect.h}` : '?'} 文本="${d.text}"`);
    }
  } else {
    lines.push('遮挡层：无');
  }
  if (state.tables?.length) {
    lines.push(`表格：${state.tables.map((t) => `${t.rows}行x${t.cols}列${t.visible ? '' : '(不可见)'}`).join('  ')}`);
  }
  lines.push(`可见元素（${state.interactive?.length ?? 0} 个）：`);
  for (const el of (state.interactive ?? []).slice(0, 25)) {
    lines.push(`  · ${el.tag}${el.id ? `#${el.id}` : ''} "${el.text}" `
      + `rect=${el.rect ? `${el.rect.x},${el.rect.y},${el.rect.w}x${el.rect.h}` : '?'}`);
  }
  lines.push(`页面可见文本（前 600 字）：`);
  lines.push(`  ${String(state.visibleText ?? '').slice(0, 600)}`);
  lines.push('');
  return lines.join('\n');
}

/**
 * 站点标签 → 该站点的 URL 片段。
 *
 * 唯一来源是 `date-picker.mjs` 的 `siteAdapter` —— **不在这里抄第二份字符串**：
 * 抄一份的漂开症状是「感知层去拍另一家站点的页面」，而那正是本模块 2026-10-12 要治的病，
 * 用同样的手法再犯一次没有说服力。认不出来的标签返回 `null`（调用点按「没给提示」处理）。
 */
export function siteFragmentFor(site) {
  try {
    return siteAdapter(String(site ?? '')).urlFragment ?? null;
  } catch {
    return null;
  }
}

/**
 * 从 `/targets` 的结果里挑「这一份失败现场该拍哪一页」。
 *
 * 为什么不能一直取 `pages[0]`（2026-10-12 实证）：店铺实例的**第一个**非 `about:` 页签是
 * 店铺标识页（`runtime/shop-window-label.html`），于是 `promotion-fetch` 失败时采到的
 * 是那一页 —— 现场文件在、`ok:true`、内容却与出事的那一页无关，
 * `evidence/batches-2026-10-10/b1/里可林淘宝/98-failure-state.txt` 的 URL 逐字是证据。
 * 而「没人查」从来不是原因：现场一直在采，只是**采错了页**。
 *
 * 取页顺序（写清楚，别让人以为它总能选对）：
 *   ① 给了 `pageHint`（站点标签）⇒ 用 `runtime/target-url-match.mjs` 的 `pagesMatching`
 *      挑该站点的页 —— 那是全仓唯一的页签归属判据，不在这里另写一套 includes；
 *   ② ① 挑不到（那一页不在、被导航走了）⇒ 退回「第一个非 `about:` 页签」（历史行为逐字不变）；
 *   ③ 连非 `about:` 页签都没有 ⇒ 挑第一个页签，让调用点去报「读不到任何页签」。
 *
 * `how` 一路带到返回值里：调用点必须能说清「这一页是按提示选的还是退回的」——
 * 分不清这两者，下一次诊断又会回到靠猜。
 *
 * @param {Array<object>} targets 代理 `/targets` 的结果
 * @param {{pageHint?: string|null}} [o] pageHint 是站点标签（`alimama` / `sycm`），
 *        来源是 `repair-actions.mjs` 的 `STAGE_PAGE_HINT`，不是页面知识。
 * @returns {{target: object|null, how: 'pageHint'|'firstNonAboutPage'|'none',
 *            pageHint: string|null, fragment: string|null}}
 */
export function pickFailureTarget(targets, { pageHint = null } = {}) {
  const list = Array.isArray(targets) ? targets : [];
  const pages = list.filter((t) => t?.type === 'page' && !String(t.url ?? '').startsWith('about:'));
  const fragment = siteFragmentFor(pageHint);
  if (fragment) {
    const matched = pagesMatching(list, fragment);
    if (matched.length > 0) {
      return { target: matched[0], how: 'pageHint', pageHint: String(pageHint), fragment };
    }
  }
  const fallback = pages[0] ?? list[0] ?? null;
  return {
    target: fallback,
    how: fallback ? 'firstNonAboutPage' : 'none',
    pageHint: pageHint ?? null,
    fragment: fragment ?? null,
  };
}

/**
 * 一次失败现场的采集动作。**永不抛**：三项各自 `{ ok, ... }`。
 *
 * @param {object}   o
 * @param {string}   o.proxy        该店 CDP 代理基址（如 http://127.0.0.1:19041）
 * @param {string}   o.logDir       该店证据目录（产物落这里）
 * @param {string}   o.shopKey
 * @param {string}   o.stage        失败阶段名
 * @param {string}   o.error        主线的失败原因（只记录，不改写）
 * @param {string}   [o.pageHint]   站点标签（`alimama` / `sycm`）—— 该拍哪一站的页。
 *                                  来源是 `repair-actions.mjs` 的 `STAGE_PAGE_HINT`；
 *                                  不给就走历史行为（第一个非 `about:` 页签）。
 * @param {Function} [o.readTargets] 读代理 /targets（可注入，离线可断言）
 * @param {Function} [o.evalInPage] 在页面里执行表达式（可注入）
 * @param {Function} [o.screenshot] 取截图（可注入）
 * @param {Function} [o.writeFile]  落盘（可注入）
 * @param {Function} [o.log]        打印
 * @returns {Promise<object>} { ok, files, state, errors } —— 结构固定，便于断言
 */
export async function captureFailureState({
  proxy, logDir, shopKey = null, stage = null, error = null, pageHint = null,
  readTargets, evalInPage, screenshot, writeFile = null, log = console.log,
} = {}) {
  const fsWrite = writeFile ?? (await import('node:fs')).writeFileSync;
  const path = await import('node:path');
  const result = { ok: false, files: {}, state: null, errors: [], shopKey, stage, selected: null };

  // 目标页：按调用方给的站点提示挑该站点的页（`pickFailureTarget`），挑不到才退回
  // 「第一个非 about: 页签」这个历史行为。取不到就整段降级 —— 但**记下来**，绝不静默变空。
  let targetId = null;
  try {
    const targets = await readTargets(proxy);
    const selection = pickFailureTarget(targets, { pageHint });
    result.selected = {
      targetId: selection.target?.targetId ?? null,
      url: selection.target?.url ?? null,
      how: selection.how,
      pageHint: selection.pageHint ?? null,
      fragment: selection.fragment ?? null,
    };
    targetId = selection.target?.targetId ?? null;
    if (!targetId) result.errors.push('读不到任何页签（代理连不上或浏览器没有页面）');
    else if (selection.how === 'firstNonAboutPage' && selection.fragment) {
      // 给了提示却挑不到那一站 ⇒ 页面不在（被导航走了/还没起来）。这不是错，但必须说：
      // 否则下一次诊断又会把「拍的是标识页」当成「页面正常」。
      log(`[${shopKey ?? '?'}]   ⚠️ 按站点提示「${selection.pageHint}」没挑到页签，`
        + `退回第一个非 about 页签（${String(selection.target?.url ?? '?').slice(0, 80)}）`);
    }
  } catch (err) {
    result.errors.push(`读页签失败：${String(err?.message ?? err)}`);
  }

  if (targetId) {
    try {
      const raw = await evalInPage(proxy, targetId, FAILURE_STATE_EXPRESSION);
      const parsed = unwrapEvalValue(raw);
      // 形状要判：拿到的东西不是「现场对象」时**不许当成采到了**。
      // 原先的写法正是这里的反面 —— 一个 `{value:…}` 包装被当成现场，产物落盘但每栏都是空，
      // 而 `ok:true` 让谁都不会去查（见 unwrapEvalValue 的注释）。
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error(`取到的不是页面现场对象（拿到 ${parsed === null ? 'null' : typeof parsed}）：`
          + `${JSON.stringify(raw)?.slice(0, 200) ?? ''}`);
      }
      result.state = parsed;
      result.ok = true;
    } catch (err) {
      result.errors.push(`取页面现场失败：${String(err?.message ?? err)}`);
    }
  }

  // 落盘 JSON + 人读文本（写不下也没关系，记进 errors）。
  if (result.state) {
    try {
      const jsonPath = path.join(logDir, '98-failure-state.json');
      fsWrite(jsonPath, `${JSON.stringify(result.state, null, 2)}\n`, 'utf8');
      result.files.stateJson = jsonPath;
      const txtPath = path.join(logDir, '98-failure-state.txt');
      fsWrite(txtPath, renderFailureStateText(result.state, { shopKey, stage, error, selected: result.selected }), 'utf8');
      result.files.stateText = txtPath;
    } catch (err) {
      result.errors.push(`写现场产物失败：${String(err?.message ?? err)}`);
    }
  }

  // 截图：复用 readback 的语义 —— 失败只降级，绝不影响 JSON 结论。
  if (targetId && typeof screenshot === 'function') {
    try {
      const pngPath = path.join(logDir, '98-failure-page.png');
      await screenshot(proxy, targetId, pngPath);
      result.files.screenshot = pngPath;
      log(`[${shopKey ?? '?'}]   现场截图 = ${pngPath}`);
    } catch (err) {
      result.errors.push(`截图失败：${String(err?.message ?? err)}`);
    }
  }

  for (const e of result.errors) log(`[${shopKey ?? '?'}]   ⚠️ 现场感知降级：${e}`);
  if (result.files.stateText) log(`[${shopKey ?? '?'}]   现场事实 = ${result.files.stateText}`);
  return result;
}
