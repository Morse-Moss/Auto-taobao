// 商品底单采集的**编排与判据**（2026-10-12 从 CLI 里抽出来，为的是能被离线驱动）。
//
// 为什么抽出来：2026-10-12 里可林天猫报「下载超时」。事后翻**浏览器自己的**下载历史库
// （`edge-profiles/<店>/Default/History` 的 `downloads` 表）才查明：那天这家店的浏览器
// **一条下载记录都没有**（同批另外 7 家各有一条完整记录）⇒ 那次点击根本没产生下载请求。
// 而原版把两件不同的事实混成了一句符号：
//   (a) 点击时锚点已经不在（读状态与点击之间被 SPA 重渲染）—— `e.click()` 的返回值被**丢弃**；
//   (b) 锚点在、点了，但什么都没发生（导出没被受理）。
// 原版既**不看返回值**、也**不重试**、失败还**不落现场** ⇒ 判因只能靠人事后翻数据库。
//
// 现在三条都补上：
//   1. 每次点击都读返回值并落进 attempt 记录（`clicked:false` 就是「点的时候锚点不在」）；
//   2. 整段最多试 `attempts` 次，每次**重新导航**拿一张干净的页（SPA 陈旧 DOM 是本仓的老坑）；
//   3. 全败时把现场（每轮读数 / Downloads 目录快照 / 页签清单 / 截图）写进 `evidenceDir`。
// 错误信息里**保留「下载超时」四个字**：上层 `runtime/workflow-receipt.mjs` 的
// `classifyWorkflowError` 正是靠它把这种失败归成 `TRANSIENT_EXTERNAL/EXTERNAL_RETRYABLE`。
//
// 判据在 `collect-product-core.test.mjs`（有状态的假代理，不碰网络也不碰真浏览器）。
// 真机上还要再跑一次演练，两步都不能省。
import { mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const DOWNLOAD_FILE_PREFIX = '【生意参谋平台】商品_全部_';
export const ITEM_RANK_URL = 'https://sycm.taobao.com/cc/item_rank';
export const DEFAULT_ATTEMPTS = 3;
export const DEFAULT_DAY_TIMEOUT_MS = 30000;
export const DEFAULT_READY_TIMEOUT_MS = 30000;
export const DEFAULT_DOWNLOAD_TIMEOUT_MS = 30000;

// 「生意参谋工作页」的归属判据。与 `runtime/target-url-match.mjs` 同一口径：
// 只认这两个 URL 形状，别退回 `includes(某个片段)` 的糊法。
export const WORK_PAGE_URL_MATCHERS = Object.freeze([
  'sycm.taobao.com/qos/service/frame/shop/performance',
  'sycm.taobao.com/cc/item_rank',
]);

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 四条注入到页面里的表达式**只在这里写一份**：假代理按**逐字相等**来分派请求，
// 所以它们同时是「这条链发了什么」的判据（用例直接 import 这几个常量）。
export const identityExpr = (expected) => `JSON.stringify({shop:[...document.querySelectorAll('a,span,div')].map(x=>(x.innerText||x.textContent||'').trim()).find(x=>x===${JSON.stringify(expected)})||''})`;
export const clickDayExpr = () => "(()=>{const b=[...document.querySelectorAll('button,[role=button],a,span')].find(x=>(x.innerText||x.textContent||'').trim()==='日');if(!b)return false;b.click();return true})()";
export const readStateExpr = () => 'JSON.stringify({url:location.href,text:document.body.innerText.slice(0,600),download:!!document.querySelector("a.sycm-traced-download-text")})';
export const clickDownloadExpr = () => "(()=>{const e=document.querySelector('a.sycm-traced-download-text');if(!e)return false;e.click();return true})()";

/** 下载目录里匹配商品底单前缀的文件名。 */
export function listDownloads(downloads, prefix = DOWNLOAD_FILE_PREFIX) {
  try { return readdirSync(downloads).filter((name) => name.startsWith(prefix)); } catch { return []; }
}

/** 出现过的、`before` 里没有的那些文件名。 */
export function freshDownloads(before, names) {
  return names.filter((name) => !before.has(name));
}

/** 页面是否已经停在「目标日 + 日粒度 + 有下载锚点」这一态（原判据逐字保留）。 */
export function isReady(state, date) {
  if (!state) return false;
  const url = String(state.url ?? '');
  return url.includes('dateType=day') && url.includes(date) && Boolean(state.download);
}

/** 工作页归属：type=page 且 URL 命中登记的形状。 */
export function workPagesOf(targets) {
  return (Array.isArray(targets) ? targets : []).filter((entry) => entry?.type === 'page'
    && WORK_PAGE_URL_MATCHERS.some((matcher) => String(entry.url ?? '').includes(matcher)));
}

async function evalValue(fetchImpl, proxy, target, expression) {
  const response = await fetchImpl(`${proxy}/eval?target=${encodeURIComponent(target)}`, { method: 'POST', body: expression });
  const text = await response.text();
  if (!response.ok) throw new Error(`/eval HTTP ${response.status} ${text.slice(0, 200)}`);
  return JSON.parse(text).value;
}

async function readState(fetchImpl, proxy, target) {
  const value = await evalValue(fetchImpl, proxy, target, readStateExpr());
  return typeof value === 'string' ? JSON.parse(value) : value;
}

async function readTargets(fetchImpl, proxy) {
  const response = await fetchImpl(`${proxy}/targets`);
  const text = await response.text();
  if (!response.ok) throw new Error(`/targets HTTP ${response.status} ${text.slice(0, 200)}`);
  return JSON.parse(text);
}

/** 失败现场：每轮读数 + 目录快照 + 页签清单 + 截图（截图单独走裸 fetch，端点闲置后首条常 500）。 */
export async function writeFailureSnapshot({ fetchImpl, proxy, evidenceDir, shop, date, note, attempts, downloads }) {
  let pages = [];
  try {
    pages = (await readTargets(fetchImpl, proxy)).filter((entry) => entry?.type === 'page').map((entry) => ({ targetId: entry.targetId, url: String(entry.url) }));
  } catch { pages = []; }
  const snapshot = {
    at: new Date().toISOString(),
    shop,
    date,
    note,
    prefix: DOWNLOAD_FILE_PREFIX,
    downloadsDir: downloads,
    attempts,
    downloadsMatchingPrefix: listDownloads(downloads),
    pages,
  };
  const target = pages.find((page) => page.url.includes('sycm.taobao.com'))?.targetId;
  if (target) {
    try {
      const response = await fetchImpl(`${proxy}/screenshot?target=${encodeURIComponent(target)}`);
      if (response.ok) {
        mkdirSync(evidenceDir, { recursive: true });
        const file = path.join(evidenceDir, `${date}-${shop}.failure.png`);
        writeFileSync(file, Buffer.from(await response.arrayBuffer()));
        snapshot.screenshot = file;
      } else snapshot.screenshotError = String(response.status);
    } catch (error) { snapshot.screenshotError = String(error?.message ?? error); }
  }
  try {
    mkdirSync(evidenceDir, { recursive: true });
    const file = path.join(evidenceDir, `${date}-${shop}.failure.json`);
    writeFileSync(file, `${JSON.stringify(snapshot, null, 2)}\n`);
    snapshot.json = file;
  } catch { /* 现场写不下去不该盖掉真正的失败原因 */ }
  return snapshot;
}

/**
 * 采一份商品底单，返回 `{ file, bytes, shop, date, attempts, missedClicks }`；失败抛错并先落现场。
 * 依赖注入的只有 `fetchImpl` / `sleep`：这样用例可以在**本地目录 + 假代理**上把整段跑完。
 */
export async function collectProductReport({
  proxy, shop, date, downloads, expectedIdentity, evidenceDir,
  fetchImpl = fetch, sleep = defaultSleep, log = () => {},
  attempts = DEFAULT_ATTEMPTS,
  dayTimeoutMs = DEFAULT_DAY_TIMEOUT_MS,
  readyTimeoutMs = DEFAULT_READY_TIMEOUT_MS,
  downloadTimeoutMs = DEFAULT_DOWNLOAD_TIMEOUT_MS,
}) {
  const attemptLog = [];
  let missedClicks = 0;
  let lastState = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    // 每一轮都**重新发现页签**再导航：SPA 陈旧 DOM 是本仓反复踩的坑，重试的全部价值就在于换一张干净的页。
    const pages = workPagesOf(await readTargets(fetchImpl, proxy));
    if (pages.length !== 1) throw new Error(`expected one SYCM work page, got ${pages.length}`);
    const target = pages[0].targetId;

    if (attempt === 1) {
      const identity = await evalValue(fetchImpl, proxy, target, identityExpr(expectedIdentity));
      const identityValue = typeof identity === 'string' ? JSON.parse(identity) : identity;
      if (identityValue?.shop !== expectedIdentity) throw new Error(`shop identity mismatch: expected ${expectedIdentity}`);
    }

    await fetchImpl(`${proxy}/navigate?target=${encodeURIComponent(target)}&url=${encodeURIComponent(ITEM_RANK_URL)}`);

    let dayClicked = false;
    const dayDeadline = Date.now() + dayTimeoutMs;
    while (!dayClicked && Date.now() < dayDeadline) {
      dayClicked = (await evalValue(fetchImpl, proxy, target, clickDayExpr())) === true;
      if (!dayClicked) await sleep(1000);
    }
    if (!dayClicked) throw new Error('日按钮未找到（轮询 30s 仍未渲染）');

    let ready = false;
    const readyDeadline = Date.now() + readyTimeoutMs;
    while (!ready && Date.now() < readyDeadline) {
      await sleep(2000);
      lastState = await readState(fetchImpl, proxy, target);
      ready = isReady(lastState, date);
    }
    if (!ready) throw new Error(`商品排行日期或下载按钮未就绪: ${JSON.stringify(lastState)}`);

    const before = new Set(listDownloads(downloads));
    // 点击的返回值**必须读**：false 就是「我读状态那一刻锚点还在、点的时候不在了」——
    // 这正是原版丢掉的那半个事实，也是今天唯一能区分「锚点消失」与「点了没效果」的东西。
    const clicked = (await evalValue(fetchImpl, proxy, target, clickDownloadExpr())) === true;
    if (!clicked) missedClicks += 1;

    const deadline = Date.now() + downloadTimeoutMs;
    let file = null;
    while (Date.now() < deadline) {
      await sleep(2000);
      const fresh = freshDownloads(before, listDownloads(downloads));
      if (fresh.length) {
        // 同批串行采集（五家共用一个真实下载目录），所以「新出现的最新一份」就是本店那一份。
        fresh.sort((a, b) => statSync(path.join(downloads, b)).mtimeMs - statSync(path.join(downloads, a)).mtimeMs);
        file = path.join(downloads, fresh[0]);
        break;
      }
    }
    attemptLog.push({ attempt, clicked, file, state: lastState, freshSeen: freshDownloads(before, listDownloads(downloads)) });
    if (file) {
      log(`[底单] ${shop} 第 ${attempt} 次尝试成功（点击返回值=${clicked}）`);
      return { shop, date, file, bytes: statSync(file).size, attempts: attempt, missedClicks };
    }
    log(`[底单] ${shop} 第 ${attempt}/${attempts} 次尝试未取到文件（点击返回值=${clicked}）`);
  }

  await writeFailureSnapshot({
    fetchImpl, proxy, evidenceDir, shop, date, attempts: attemptLog, downloads,
    note: `点击后 ${downloadTimeoutMs}ms 内 Downloads 未出现新的「${DOWNLOAD_FILE_PREFIX}」文件；共试 ${attempts} 次`,
  });
  throw new Error(`下载超时（点击返回值=已记录；共试 ${attempts} 次，其中 ${missedClicks} 次点击时锚点不在）`);
}
