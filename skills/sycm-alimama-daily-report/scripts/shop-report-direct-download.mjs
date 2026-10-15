#!/usr/bin/env node
//
// 日报链「店铺报表」的**直下通道**（2026-10-15 加）。
//
// 为什么要有这个模块：平台（生意参谋「自助分析·公共空间」）在 2026-10-14 中午之后
// 把日报导出改成了「点『下载报表』→ OSS 生成文件 → 用 target=_blank 锚点打开
// Microsoft Office Online Viewer 在新标签页**预览**」—— 文件**永不落盘**。
// 采集脚本的文件系统判据于是永远超时：2026-10-14 目标日的日报链 8 家店 × 3 轮
// 补跑全败在同一处（第 5 步 shop-report，30 秒等不到新文件）。
//
// 根因证据（tmp/rootcause-20261015/）：点下载后页面确实走了
// download.json / queryDownloadUrl.json（都 200），OSS 上也真有文件
// （签名 URL 直下实测 200、19732 字节、PK 头、内含目标日数据）——
// 缺的只是「文件进下载目录」这一步。而签名 URL 在**页面上拿得到**
// （平台自建锚点后调 a.click()，探针 A 用不可信手势也照样走到了这一步）。
//
// 所以修法＝交付层多一条通道：抓到签名 URL 就从 Node 侧直取落盘，
// 文件名沿用平台给的（下游 import/push 的判据本来就认它）。
// 这不是替代老通道，是**并行**：平台若回滚成直接落盘，老通道照旧生效。
import { writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * 从直下 URL 里取**落盘文件名**：路径最后一段，百分号解码。
 *
 * 为什么必须解码：平台给的是编码路径（`%E6%97%A5%E6%8A%A5_20261015_….xlsx`）。
 * 不解码就落盘，文件名会是一串百分号 —— 而下游判据（`shopReportNamePattern`）
 * 认的是解码后的中文名，于是「文件明明下来了却没人认」。
 *
 * 取不到（不是绝对 URL、没有路径段）⇒ `null`：调用方据此把它剔出候选。
 */
export function fileNameFromDirectUrl(url) {
  let parsed;
  try {
    parsed = new URL(String(url ?? ''));
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  const last = parsed.pathname.split('/').filter(Boolean).pop();
  if (!last) return null;
  try {
    return decodeURIComponent(last) || null;
  } catch {
    // 解码失败（编码残缺）⇒ 用原样；过不过得了判据由 pattern 门决定
    return last || null;
  }
}

/**
 * 这个 URL 能不能当成本店日报工作簿的直下候选。
 *
 * 判据只有一条：**文件名过得去店家的 `reportPattern`**（调用方传进来）。
 * 主机名/路径形状一律不设硬编码 —— 平台换 OSS 桶、换目录结构不该让链路瞎；
 * 但文件名不认 ⇒ 一律不收（fail-closed）：宁可超时报错，
 * 也不把某个不明 xlsx 当成日报写进回执、推到底单里。
 *
 * `pattern` 必须是 RegExp（`shopReportNamePattern()` 的产物）。传别的 ⇒ 抛错，
 * 不静默当成「不匹配」—— 那会把「判据没给对」演成「平台没给 URL」。
 */
export function isDirectDownloadCandidate(url, pattern) {
  if (!(pattern instanceof RegExp)) {
    throw new Error('isDirectDownloadCandidate 需要 RegExp 判据（shopReportNamePattern 的产物）');
  }
  const name = fileNameFromDirectUrl(url);
  if (!name) return false;
  return pattern.test(name);
}

/**
 * 多个候选取**最后一个**。
 *
 * 为什么是最后不是第一：平台每次导出都会**新签**一个 URL（`Expires` 不同，
 * 路径却相同）。探针实测：一次点击后页面出现两条同路径、不同 Expires 的候选。
 * 签名有时效（实测约 20 分钟量级），最后一条最新 —— 拿旧签名去下只会 403。
 */
export function pickDirectDownloadUrl(urls, pattern) {
  const list = Array.isArray(urls) ? urls : [];
  for (let index = list.length - 1; index >= 0; index -= 1) {
    if (isDirectDownloadCandidate(list[index], pattern)) return list[index];
  }
  return null;
}

/**
 * 页面内仪表：**赶在点「下载报表」之前**装上，把平台自己搞出来的 OSS 签名 URL
 * 记进 `window.__sycmDirectUrls`。
 *
 * ⚠️ href 一律拿全、**不许 slice**：根因探针第一版把 href `slice(0, 200)`，
 * `Signature` 查询参数被截掉 ⇒ 拿残缺 URL 直下只会 403（探针自己的教训）。
 * 这条由 `shop-report-direct-download.test.mjs` 的用例直接钉住。
 *
 * 三个渠道写同一个数组（平台换哪种实现都至少有一条能拿到）：
 *   ① `HTMLAnchorElement.prototype.click` —— 平台自建锚点后触发下载的标准动作。
 *      实测：采集脚本用的是 JS 点击（不可信手势）、Viewer 新标签页弹不出来，
 *      **这一步照样走**（探针实验 A）—— 所以不依赖可信手势也能拿到 URL；
 *   ② `window.open` —— 兜底。拿到 Office Viewer 地址时，从 `src` 参数里
 *      取回里面的 OSS URL（Viewer 页签的完整 src 也是拿全 URL 的一条路）；
 *   ③ `MutationObserver` —— 锚点被插进 DOM 但没被点也会被观察到。
 */
export function installDirectDownloadCaptureExpression() {
  return `(() => {
    if (window.__sycmDirectUrls) return 'already';
    window.__sycmDirectUrls = [];
    const push = (raw) => {
      let value = String(raw || '');
      if (!value) return;
      try {
        const parsed = new URL(value);
        const src = parsed.searchParams.get('src');
        if (src && /view\\.aspx$/i.test(parsed.pathname)) value = src;
      } catch (e) { /* 不是绝对 URL 的不管 */ }
      if (/^https?:\\/\\//i.test(value) && !window.__sycmDirectUrls.includes(value)) {
        window.__sycmDirectUrls.push(value);
      }
    };
    const oac = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function (...args) {
      try { push(this.href); } catch (e) { /* 读不到 href 就放弃这条 */ }
      return oac.apply(this, args);
    };
    const ow = window.open;
    window.open = function (...args) {
      try { push(args[0]); } catch (e) { /* 同上 */ }
      return ow.apply(this, args);
    };
    const obs = new MutationObserver((records) => {
      for (const record of records) for (const node of record.addedNodes) {
        if (node.nodeType !== 1) continue;
        try {
          if (node.tagName === 'A') push(node.href);
          if (node.querySelectorAll) for (const a of node.querySelectorAll('a')) push(a.href);
        } catch (e) { /* 跨域/坏节点，跳过 */ }
      }
    });
    obs.observe(document.documentElement, { childList: true, subtree: true });
    return 'installed';
  })()`;
}

/** 读回仪表记到的所有 URL（原样、拿全的）。 */
export function readDirectDownloadUrlsExpression() {
  return '(() => JSON.stringify(window.__sycmDirectUrls || []))()';
}

/**
 * 直取并落盘。三道校验，任何一条不过都抛错（调用方可以选择继续等老通道）：
 *   ① 文件名得过店家的 `reportPattern` —— 与挑选候选用同一把尺子，
 *      这里是**落盘前最后一道门**：判据换了、URL 换了，都不许默默写盘；
 *   ② HTTP 200 —— 签名 URL 有过期时间，403 多半是拿晚了（或拿了残缺的）；
 *   ③ 内容是 xlsx（zip）：头两字节 `PK` —— 平台返回错误页/HTML 时靠这条拦住，
 *      否则一个 200 的 HTML 会被当成「下载成功」写进回执。
 *
 * 返回值与老通道打的那句 `shopXlsxPath` 对齐：`{ name, size, path }`。
 */
export async function fetchDirectDownload({
  url, dir, pattern, fetchImpl = fetch, writeFileImpl = writeFile,
} = {}) {
  if (!dir) throw new Error('fetchDirectDownload 需要落盘目录（dir）');
  const name = fileNameFromDirectUrl(url);
  if (!name || !(pattern instanceof RegExp) || !pattern.test(name)) {
    throw new Error(`直下 URL 的文件名 ${JSON.stringify(name)} 过不了店家文件名判据：不收这个文件`);
  }
  const response = await fetchImpl(url);
  if (!response?.ok) {
    let detail = '';
    try {
      detail = String(await response.text()).slice(0, 120);
    } catch {
      detail = '（响应体读不到）';
    }
    throw new Error(`直下 HTTP ${response?.status ?? '无响应'} ${detail}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length < 4 || buffer[0] !== 0x50 || buffer[1] !== 0x4b) {
    throw new Error(`直下内容不是 xlsx（zip 头 PK）：${buffer.length} 字节，`
      + `头 8 字节 ${buffer.subarray(0, 8).toString('hex')}`);
  }
  const target = path.join(dir, name);
  await writeFileImpl(target, buffer);
  return { name, size: buffer.length, path: target };
}
