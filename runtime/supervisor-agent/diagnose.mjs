// 监督 Agent L3 诊断层：故障分类学 + 确定性规则诊断。
// 规则优先于 LLM：能用确定性签名回答的，绝不调用模型（公理 1）。

export const FAILURE_CLASSES = {
  STALL_PAGE_REQUEST: 'STALL_PAGE_REQUEST',
  EXPORT_DOWNLOAD_TIMEOUT: 'EXPORT_DOWNLOAD_TIMEOUT',
  LOGIN_REQUIRED: 'LOGIN_REQUIRED',
  PLATFORM_CONTROL: 'PLATFORM_CONTROL',
  BROWSER_DEBUG_PORT: 'BROWSER_DEBUG_PORT',
  FLOW_HUMAN_GATE: 'FLOW_HUMAN_GATE',
  UNKNOWN: 'UNKNOWN',
};

function lastEvent(events = []) {
  return events.length ? events[events.length - 1] : null;
}

function hasEvent(events = [], name) {
  return events.some((e) => e?.event === name);
}

function maxCompletedPage(events = []) {
  return events.reduce((max, e) => (e?.event === 'PROGRESS' && e.completedPage > max ? e.completedPage : max), 0);
}

/**
 * 确定性诊断。输入 incident：
 * { status, error, stage, flow, runId, events: [...] }
 * 输出：{ failureClass, rootCause, remedy, actions: [{type, params}], confidence }
 * actions 的 type 必须在 ACTION_WHITELIST 内（由调用方 actions.mjs 校验）。
 */
export function ruleTriage(incident) {
  const error = String(incident?.error ?? '');
  const status = String(incident?.status ?? '');
  const events = Array.isArray(incident?.events) ? incident.events : [];
  const page = maxCompletedPage(events);

  // ---- 登录失效：可确定，唯一正确动作是开登录窗口 + 升级人工 ----
  if (/requires Xiaowangshen login|需要.*登录|LOGIN_REQUIRED/iu.test(error)
    || /请登录/.test(error)) {
    return {
      failureClass: FAILURE_CLASSES.LOGIN_REQUIRED,
      rootCause: '插件/平台的登录态丢失（cookie 加密绑定原 profile、会话过期等）',
      remedy: '打开浏览器窗口供人工重新登录；登录后自动续跑由外层负责',
      actions: [
        { type: 'reopen_login_window', params: { url: incident?.loginUrl ?? 'https://www.taobao.com/' } },
        { type: 'escalate_human', params: { reason: '需要人工扫码登录，Agent 无法也不应代办凭据' } },
      ],
      confidence: 0.95,
    };
  }

  // ---- 平台风控页：可确定，交给人工 ----
  if (/platform control|访问受限|滑块|验证码/iu.test(error)) {
    return {
      failureClass: FAILURE_CLASSES.PLATFORM_CONTROL,
      rootCause: '平台风控在页面上呈现了人机验证或受限页',
      remedy: '升级人工在可见浏览器窗口完成验证；Agent 不得尝试绕过',
      actions: [
        { type: 'escalate_human', params: { reason: '平台风控验证需要人工完成，禁止自动绕过' } },
      ],
      confidence: 0.9,
    };
  }

  // ---- 部分导出下载超时：本轮实际发生的故障 A 之一 ----
  if (/Timed out waiting for \.csv download|Timed out waiting for \.xlsx download/iu.test(error)
    || hasEvent(events, 'PARTIAL_EXPORT_FAILED')) {
    return {
      failureClass: FAILURE_CLASSES.EXPORT_DOWNLOAD_TIMEOUT,
      rootCause: '导出下载等待窗口（默认 30 秒）短于插件实际生成产物的时间；'
        + '网络或插件导出通道在卡停后也未及时产出文件',
      remedy: '把导出下载等待放宽到 120 秒，并同步放宽卡停阈值后重启流程',
      actions: [
        {
          type: 'restart_flow_with_params',
          params: {
            overrides: {
              exportDownloadTimeoutSeconds: 120,
              stallSeconds: Math.max(900, Number(incident?.params?.stallSeconds ?? 0)),
            },
          },
        },
      ],
      confidence: 0.85,
    };
  }

  // ---- 页面请求挂起（卡停）：本轮实际发生的故障 A 之二 ----
  const stallPending = events.find((e) => e?.event === 'DIAGNOSTIC' && e?.kind === 'REQUEST_PENDING');
  const stalled = /stall|no progress|STALLED/iu.test(error) || status === 'STALLED' || Boolean(stallPending);
  if (stalled) {
    return {
      failureClass: FAILURE_CLASSES.STALL_PAGE_REQUEST,
      rootCause: `页面请求长时间无响应（已完成 ${page} 页后挂起），疑似限流/网络抖动/插件请求悬挂`,
      remedy: '放宽卡停阈值并降低请求频率后重启；若复发则需进一步抓包定位',
      actions: [
        {
          type: 'restart_flow_with_params',
          params: {
            overrides: {
              stallSeconds: Math.max(900, Number(incident?.params?.stallSeconds ?? 0)),
              frequencyMin: 45,
              frequencyMax: 60,
            },
          },
        },
      ],
      confidence: 0.8,
    };
  }

  // ---- 浏览器调试端口失联：本会话前半夜真实踩过 ----
  if (/ECONNREFUSED|debug port|DevTools/iu.test(error)) {
    return {
      failureClass: FAILURE_CLASSES.BROWSER_DEBUG_PORT,
      rootCause: '浏览器调试端口未监听（浏览器被关闭、端口被占或启动参数失效）',
      remedy: '以 CLI 调试模式重启浏览器（复制 profile + --remote-debugging-port），重启后再拉流程',
      actions: [
        { type: 'restart_flow_with_params', params: { overrides: { relaunchBrowser: true } } },
      ],
      confidence: 0.85,
    };
  }

  // ---- 编排器人工门：这是设计内行为，不是故障 ----
  if (/STOP_HUMAN|HUMAN_REQUIRED/iu.test(error) || status === 'HUMAN_REQUIRED') {
    return {
      failureClass: FAILURE_CLASSES.FLOW_HUMAN_GATE,
      rootCause: '规则流程按设计停在人工门（发布授权、内容审核等）',
      remedy: '通知人工处理；无需任何自动修复',
      actions: [
        { type: 'escalate_human', params: { reason: incident?.reason ?? '人工门' } },
      ],
      confidence: 0.7,
    };
  }

  // ---- 规则无法分类：留给 L3 第三级（LLM），或升级人工 ----
  return {
    failureClass: FAILURE_CLASSES.UNKNOWN,
    rootCause: '确定性规则无法分类',
    remedy: '转 LLM 诊断；LLM 不可用则升级人工',
    actions: [
      { type: 'escalate_human', params: { reason: '未知故障类别' } },
    ],
    confidence: 0.2,
  };
}

export function incidentSignature(incident, failureClass) {
  const error = String(incident?.error ?? '');
  // 取错误文本中稳定的中段作为签名（去掉时间戳、随机 id、路径）
  const normalized = error
    .replace(/\d{4}-\d{2}-\d{2}T[0-9:.]+Z?/gu, '<ts>')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/giu, '<uuid>')
    .replace(/[A-Z]:\\[^"]+/gu, '<path>')
    .replace(/\d+/gu, '<n>')
    .slice(0, 160);
  return { failureClass, errorPattern: normalized, stage: incident?.stage ?? null };
}

export { lastEvent };
