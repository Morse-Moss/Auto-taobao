// 通过「手动调试端口」连接浏览器时的身份与端口来源。
//
// 2026-09-17 修（坑 52）：这三个默认值原先写死在文件里，而且是**自相矛盾**的一组 ——
//   端口 `9223` 是**日报用的商家浏览器**在迁移前的旧值（已退役，见 RETIRED_PORTS），
//   身份 `edge-isolated` / `Microsoft Edge (isolated)` 却是**竞品买家**浏览器。
// 于是裸跑 cdp-proxy（不传 CDP_BROWSER_PORT）会「自称买家、实连商家」，而且导出侧那条
// 「XWS_BROWSER_ID 与 /health 的 browser.id 一致」的校验因为两边同源而**照样通过**。
//
// 现在三个值都从 runtime/browser-ports.mjs 取，且落在同一条链上（competitor = 买家链）：
// 身份自报什么，就连什么。这不是「补个默认值」，而是让「默认值即目标」（坑 35）在
// 这里不再成立 —— 默认值来自唯一来源，改端口只改登记表一处。
//
// 为什么默认落在 competitor 而不是 dailyReport：本模块自报的身份就是 `edge-isolated`
// （竞品买家链），身份与目标必须同链，否则又是一次「自称 A、实连 B」。
// 日报链走 runtime/start-daily-report-proxy.mjs，那里显式把三个值都设成乙。
import { BROWSER_IDS, BROWSER_LABELS, PROJECT_PORTS, resolvePort } from '../browser-ports.mjs';

// resolvePort：非法值抛错而不是静默取默认（静默回落到 NaN 会让 fetch 报一个
// 与真实原因无关的错）。显式传了 CDP_BROWSER_PORT 就优先用显式的。
const ISOLATED_PORT = resolvePort('CDP_BROWSER_PORT', PROJECT_PORTS.competitorBrowser);
const ISOLATED_BROWSER_ID = process.env.CDP_BROWSER_ID || BROWSER_IDS.competitor;
const ISOLATED_BROWSER_LABEL = process.env.CDP_BROWSER_LABEL || BROWSER_LABELS.competitor;

export async function selectBrowser() {
  const version = await fetch(`http://127.0.0.1:${ISOLATED_PORT}/json/version`).then((response) => response.json());
  const wsUrl = new URL(version.webSocketDebuggerUrl);
  return {
    kind: 'ok',
    source: 'isolated-runtime',
    browser: {
      id: ISOLATED_BROWSER_ID,
      label: ISOLATED_BROWSER_LABEL,
      port: ISOLATED_PORT,
      wsPath: `${wsUrl.pathname}${wsUrl.search}`,
    },
    detected: [],
    configured: null,
  };
}

// 「我准备连谁」——给调用方拼错误信息用。
// 原先这里叫 findFallbackPort()，是 cdp-proxy 末尾那条兜底分支的产物；那条分支永远走不到
// （selectBrowser 要么返回 kind:'ok'，要么抛错），已于 2026-09-17 连同兜底一起删掉。
// 现在它的用途只剩一个：连不上时能说清「连的是哪个端口、自报的哪个身份」。
export function describeIsolatedTarget() {
  return { id: ISOLATED_BROWSER_ID, label: ISOLATED_BROWSER_LABEL, port: ISOLATED_PORT };
}
