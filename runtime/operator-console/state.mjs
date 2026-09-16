// 运营台的数据加工层：把「真相源文件 / 端口登记表」摊成页面能直接渲染的形状。
//
// 这一层的铁律（docs/ops/OPERATOR-CONSOLE-INTERACTION.md §0 第 1 条）：
// 它只做「读文件 + 摊平」两件事，**不产生任何新状态**。所以这里的每个字段都要能回答
// 「它读的是哪个文件」；答不上来的字段在这里就不该存在 —— 示例数据也必须显式打 sample 标，
// 否则界面会变成第二份状态真相（那是本项目最不想要的东西）。
//
// 分组口径全部从 runtime/browser-ports.mjs 读，不硬编码：
// 页面上「甲列 / 乙列」的分法必须与启动器、登记表三处同一口径（§3.1）。

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  BROWSER_ACCOUNT,
  BROWSER_LABELS,
  BROWSER_PROFILES,
  PROJECT_PORTS,
  ROUTES,
  classifyPortUsage,
  describeBrowserRoutes,
  describeOccupant,
  inspectPort,
  routesOnBrowser,
} from '../browser-ports.mjs';
import { describeFaqStages, determineFaqOperatorState } from '../faq-operator-core.mjs';

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
// 用模块自身位置定位仓库，而不是 cwd：这样从任何目录启动控制台读到的都是同一批文件
// （cwd 相关的默认值是坑 35 的经典成因）。
export const RUNTIME_ROOT = resolve(MODULE_DIR, '..');
export const REPO_ROOT = resolve(RUNTIME_ROOT, '..');

// 阶段快照的陈旧阈值，沿用 ADMISSION_STALE_AFTER_MS（§5.1 表格）。
export const STALE_AFTER_MS = 30 * 60 * 1000;

// 周期目录名形状。只认这个形状，把测试夹（stale-vacuous-…）之类的目录挡在外面。
const PERIOD_PATTERN = /^\d{4}-\d{2}-\d{2}_\d{4}-\d{2}-\d{2}$/u;

// ---------------------------------------------------------------------------
// ① 环境灯：两个浏览器 profile 的端口与配置真探
// ---------------------------------------------------------------------------

// browserKey → 它那两个端口在 PROJECT_PORTS 里的键名。
// 有测试逼着它与 BROWSER_PROFILES 逐键对齐：加了浏览器却漏登记端口会直接红，
// 而不是在页面上显示成「没在运行」（假灰与假绿一样坏）。
export const BROWSER_PORT_NAMES = Object.freeze({
  competitor: Object.freeze({ browser: 'competitorBrowser', proxy: 'competitorProxy' }),
  dailyReport: Object.freeze({ browser: 'dailyReportBrowser', proxy: 'dailyReportProxy' }),
});

export function lampForBrowserPort(usage) {
  if (usage?.verdict === 'ours') return { lamp: 'green', text: '在本项目这个 profile 上运行' };
  if (usage?.verdict === 'free') return { lamp: 'grey', text: '没在运行' };
  if (usage?.verdict === 'foreign') return { lamp: 'red', text: '端口被另一个浏览器占了' };
  return { lamp: 'amber', text: '在监听，但读不出它的身份' };
}

export function lampForProxyPort(inspection) {
  if (inspection?.status === 'occupied-unidentified') return { lamp: 'green', text: '代理在运行' };
  if (inspection?.status === 'free') return { lamp: 'grey', text: '没在运行' };
  return { lamp: 'amber', text: '端口上的东西不像本项目的代理' };
}

export function lampForProfile(path) {
  const exists = Boolean(path) && existsSync(path);
  return exists
    ? { lamp: 'green', text: '配置目录在' }
    : { lamp: 'grey', text: '配置目录还没建（首次启动时创建）' };
}

export async function buildEnvPayload(options = {}) {
  const inspect = options.inspect ?? inspectPort;
  const keys = Object.keys(BROWSER_PROFILES);
  const browsers = await Promise.all(keys.map(async (key) => {
    const names = BROWSER_PORT_NAMES[key];
    const browserPort = PROJECT_PORTS[names.browser];
    const proxyPort = PROJECT_PORTS[names.proxy];
    const [rawBrowser, rawProxy] = await Promise.all([
      inspect(browserPort, { timeoutMs: options.timeoutMs ?? 1200 }),
      inspect(proxyPort, { timeoutMs: options.timeoutMs ?? 1200 }),
    ]);
    const usage = classifyPortUsage(rawBrowser, { expectedProfile: BROWSER_PROFILES[key] });
    return {
      key,
      label: BROWSER_LABELS[key],
      account: BROWSER_ACCOUNT[key],
      profile: BROWSER_PROFILES[key],
      routesSummary: describeBrowserRoutes(key),
      routes: routesOnBrowser(key),
      lights: {
        browser: {
          port: browserPort,
          portKey: names.browser,
          verdict: usage.verdict,
          ...lampForBrowserPort(usage),
          occupant: usage.verdict === 'free' ? null : describeOccupant(rawBrowser),
        },
        proxy: {
          port: proxyPort,
          portKey: names.proxy,
          status: rawProxy.status,
          ...lampForProxyPort(rawProxy),
        },
        config: { path: BROWSER_PROFILES[key], ...lampForProfile(BROWSER_PROFILES[key]) },
      },
    };
  }));
  return {
    generatedAt: new Date().toISOString(),
    console: {
      // port = **实际监听的端口**（由服务端在 listen 后传入）。登记表里的值另列在 registryPort：
      // 只报默认值会在换端口启动时对运营说一个假端口（2026-09-16 在 19025 起实例时踩到）。
      port: options.port ?? PROJECT_PORTS.operatorConsole,
      registryPort: PROJECT_PORTS.operatorConsole,
      portKey: 'operatorConsole',
      host: '127.0.0.1',
      source: 'runtime/browser-ports.mjs#PROJECT_PORTS.operatorConsole',
    },
    // 路线清单也从登记表摊出来（启动块的「路线」下拉）。页面不许自己写一份：
    // 登记表里新增/改名一条路线，下拉里就会跟着变；页面上写死的拷贝不会。
    routes: Object.entries(ROUTES).map(([key, route]) => ({
      key,
      label: route.label,
      browser: route.browser,
      noBrowser: route.noBrowser === true,
      noBrowserReason: route.noBrowserReason ?? null,
      account: route.account,
      needsExtension: route.needsExtension ?? null,
      sites: [...route.sites],
      skills: [...route.skills],
    })),
    browsers,
  };
}

// ---------------------------------------------------------------------------
// ② 账号卡：分组是真的（来自登记表），状态是示例（体检还没按平台接进来）
// ---------------------------------------------------------------------------

// 站点 → 平台。合并同类站点是因为**它们共用一次登录**：
// s.taobao.com / item.taobao.com / detail.tmall.com 都吃同一个买家号；
// 灰豚的小红书站与抖音站吃同一个灰豚账号。
// 有测试逼着 ROUTES[*].sites 里的每个站点都在这里，否则加了新站点会静默少一张卡。
export const SITE_PLATFORM = Object.freeze({
  's.taobao.com': 'taobaoBuyer',
  'item.taobao.com': 'taobaoBuyer',
  'detail.tmall.com': 'taobaoBuyer',
  'sycm.taobao.com': 'sycm',
  'one.alimama.com': 'alimama',
  'myseller.taobao.com': 'qianniu',
  'qianniu.taobao.com': 'qianniu',
  'xhs.huitun.com': 'huitun',
  'dy.huitun.com': 'huitun',
  'feishu.cn': 'feishu',
});

// 平台 → 卡标题。用可读名，卡面上不出现编号（用户明确要求）。
// reserved = 仓库内没有调用方，只能是灰灯 + 写明「预留」；假绿灯比红灯危害大（§3.2）。
export const PLATFORM_LABELS = Object.freeze({
  taobaoBuyer: { title: '淘宝买家号', note: '小旺神插件只有买家号能用' },
  sycm: { title: '生意参谋', note: null },
  alimama: { title: '阿里妈妈 / 万相台', note: null },
  feishu: { title: '飞书网页', note: '用它自己的账号，与淘宝身份无关' },
  huitun: { title: '灰豚', note: '用它自己的账号，扫码 + 拼图验证' },
  qianniu: { title: '千牛 / 卖家工作台', note: '预留：仓库内暂无调用方', reserved: true },
});

// 状态词表与外观（照抄 docs/ops/OPERATOR-CONSOLE-INTERACTION.md §3.4 那张表）。
// `buttons` 是**页面给什么按钮**的映射 —— 它是渲染决策，不是状态；状态仍然只来自体检输出。
// `notYetEmitted` 标出「词表里有、体检还没产出」的状态：界面必须把它们与真实覆盖区分开，
// 否则会让人以为已经覆盖了风控与过期两种坏法（G1 只补了一半）。
export const AUTH_STATUS_VOCABULARY = Object.freeze([
  'AUTH_READY',
  'AUTH_EXPIRING',
  'AUTH_REQUIRED',
  'ACCOUNT_MISMATCH',
  'RISK_BLOCKED',
  'PLUGIN_UNAVAILABLE',
  'PLUGIN_NOT_READY',
  'SOURCE_MISMATCH',
  'AUTH_UNKNOWN',
]);

const STATUS_PRESENTATION = Object.freeze({
  AUTH_READY: { lamp: 'green', label: '已登录', buttons: [] },
  AUTH_EXPIRING: {
    lamp: 'amber',
    label: '即将过期',
    buttons: [{ id: 'relogin', text: '重新登录', optional: true }],
    notYetEmitted: true,
  },
  AUTH_REQUIRED: {
    lamp: 'red',
    label: '需要登录',
    buttons: [{ id: 'open-login', text: '打开登录窗口' }],
  },
  ACCOUNT_MISMATCH: {
    lamp: 'red',
    label: '账号不对',
    buttons: [{ id: 'switch-login', text: '换个账号登录' }],
  },
  RISK_BLOCKED: {
    lamp: 'red',
    label: '被风控拦住',
    buttons: [
      { id: 'manual-verify', text: '我去浏览器里完成验证' },
      { id: 'recheck', text: '我已完成，重新检查' },
    ],
    notYetEmitted: true,
  },
  PLUGIN_UNAVAILABLE: {
    lamp: 'red',
    label: '插件没加载',
    buttons: [{ id: 'reopen-browser', text: '重开这个浏览器' }],
  },
  PLUGIN_NOT_READY: {
    lamp: 'red',
    label: '插件未就绪',
    buttons: [{ id: 'reopen-browser', text: '重开这个浏览器' }],
  },
  SOURCE_MISMATCH: { lamp: 'blue', label: '不是账号问题', buttons: [] },
  AUTH_UNKNOWN: {
    lamp: 'grey',
    label: '读不到结论',
    buttons: [{ id: 'recheck', text: '重新检查' }],
  },
});

export function presentationForStatus(status) {
  const found = STATUS_PRESENTATION[String(status ?? '').trim()];
  // 没登记的状态一律当「读不到结论」，不放行也不冒充绿 —— fail-closed。
  return found ?? {
    lamp: 'grey',
    label: `未登记的状态（${String(status ?? '空')}）`,
    buttons: [{ id: 'recheck', text: '重新检查' }],
    unregistered: true,
  };
}

// 示例状态：只为把四种灯面（绿/黄/红/灰）都摆出来给人看，**不是任何检查的结果**。
// 取值刻意与设计文档 §2 的示意图一致，方便对着图核观感。
const SAMPLE_STATUS_BY_PLATFORM = Object.freeze({
  taobaoBuyer: 'AUTH_READY',
  sycm: 'AUTH_READY',
  alimama: 'AUTH_UNKNOWN',
  feishu: 'AUTH_READY',
  huitun: 'AUTH_REQUIRED',
  qianniu: null,
});

const SAMPLE_REASON = Object.freeze({
  AUTH_READY: '样例：这次检查没看到登录墙（不是真实检查结果）',
  AUTH_REQUIRED: '样例：页面出现了「登录小旺神」弹窗（不是真实检查结果）',
  AUTH_UNKNOWN: '样例：探测读不到确定结论，按不放行处理（不是真实检查结果）',
});

// 从登记表推导出「这个 profile 上有哪几张账号卡」。
// 分组来自 BROWSER_ACCOUNT / routesOnBrowser，卡片来自 ROUTES[*].sites，全部是既有真值。
export function deriveAccountGroups() {
  return Object.keys(BROWSER_PROFILES).map((key) => {
    const names = routesOnBrowser(key);
    const platforms = [];
    for (const routeName of names) {
      for (const site of ROUTES[routeName].sites) {
        const platform = SITE_PLATFORM[site];
        if (platform && !platforms.includes(platform)) platforms.push(platform);
      }
    }
    return {
      key,
      label: BROWSER_LABELS[key],
      account: BROWSER_ACCOUNT[key],
      profile: BROWSER_PROFILES[key],
      routesSummary: describeBrowserRoutes(key),
      cards: platforms.map((platform) => {
        const meta = PLATFORM_LABELS[platform];
        const reserved = meta.reserved === true;
        const status = SAMPLE_STATUS_BY_PLATFORM[platform] ?? null;
        const presentation = reserved ? { lamp: 'grey', label: '预留', buttons: [] } : presentationForStatus(status);
        return {
          accountKey: `${key}:${platform}`,
          platform,
          title: meta.title,
          note: meta.note,
          profileKey: key,
          reserved,
          // ↓ 这几个字段是界面上「真状态」该出现的位置。一期一律为 null/示例，
          //   并靠 sample=true + statusSource 让界面显式标注，绝不冒充真实体检。
          status,
          lamp: presentation.lamp,
          statusLabel: presentation.label,
          reason: reserved
            ? '预留：仓库内暂无调用方，不参与体检'
            : (SAMPLE_REASON[status] ?? '样例数据'),
          action: null,
          checkedAt: null,
          evidencePath: null,
          buttons: presentation.buttons,
          notYetEmitted: presentation.notYetEmitted === true,
          sample: true,
        };
      }),
    };
  });
}

export function buildAccountsPayload() {
  return {
    generatedAt: new Date().toISOString(),
    // 这一整块的诚实性声明：分组是真的（登记表推导），状态是示例。
    probed: false,
    statusSource: 'SAMPLE_NOT_PROBED',
    notice: '账号灯是示例数据，尚未接真实体检（体检目前只覆盖小旺神/竞品链，见 G1/G2）。'
      + '界面上的按钮是样子，点了不会有动作。',
    // 「词表里有、体检还没产出」的状态清单 —— 让缺口在界面上可见，而不是靠文档记着。
    notYetEmittedStatuses: AUTH_STATUS_VOCABULARY.filter((status) => STATUS_PRESENTATION[status]?.notYetEmitted === true),
    groups: deriveAccountGroups(),
  };
}

// ---------------------------------------------------------------------------
// ③ 进度：FAQ 链的真实状态（读 operator-status.json，回落到 evidence/ 快照）
// ---------------------------------------------------------------------------

function readJsonIfExists(path) {
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return { __parseError: true };
  }
}

// 列出所有有周期快照的周期，按开始日期倒序。
// 真相源优先级：runtime/faq-analysis/<周期>/operator-status.json（operator CLI 现役写入）
//   → evidence/faq-operator-status-<周期>.json（历史快照，按此名存过一份）
export function listPeriods({ runtimeRoot = RUNTIME_ROOT, repoRoot = REPO_ROOT } = {}) {
  const analysisDir = resolve(runtimeRoot, 'faq-analysis');
  const byPeriod = new Map();
  if (existsSync(analysisDir)) {
    for (const entry of readdirSync(analysisDir)) {
      if (!PERIOD_PATTERN.test(entry)) continue;
      const file = resolve(analysisDir, entry, 'operator-status.json');
      if (existsSync(file)) {
        byPeriod.set(entry, { source: 'runtime/faq-analysis', path: file, relativePath: `runtime/faq-analysis/${entry}/operator-status.json` });
      } else {
        byPeriod.set(entry, { source: null, path: null, relativePath: null, dirExists: true });
      }
    }
  }
  const evidenceDir = resolve(repoRoot, 'evidence');
  if (existsSync(evidenceDir)) {
    for (const entry of readdirSync(evidenceDir)) {
      const match = entry.match(/^faq-operator-status-(\d{4}-\d{2}-\d{2}_\d{4}-\d{2}-\d{2})\.json$/u);
      if (!match) continue;
      if (byPeriod.get(match[1])?.source) continue; // 现役写入优先
      byPeriod.set(match[1], {
        source: 'evidence',
        path: resolve(evidenceDir, entry),
        relativePath: `evidence/${entry}`,
      });
    }
  }
  return [...byPeriod.entries()]
    .map(([period, info]) => ({ period, ...info }))
    .sort((a, b) => b.period.localeCompare(a.period));
}

export function shapeRun(period, info, { now = Date.now() } = {}) {
  // 文件不存在时也要给出「本来该读哪个文件」：只说「取不到」而不说去哪儿找，
  // 运营就没法自查（这正是灰块与「真没问题」的区别所在）。
  const expectedRelativePath = `runtime/faq-analysis/${period}/operator-status.json`;
  if (!info.source) {
    return {
      period,
      available: false,
      // 取不到就显示灰，并且**必须带理由** —— 一个没有理由的灰块等于没有信息。
      reasonCode: info.dirExists
        ? 'NO_STATUS_FILE_IN_PERIOD_DIR'
        : 'PERIOD_NOT_FOUND',
      reason: info.dirExists
        ? `有 ${period} 这个周期的目录，但里面还没有 operator-status.json（没跑过状态检查）`
        : `没有 ${period} 这个周期的任何记录`,
      statusSource: null,
      sourcePath: null,
      lookedFor: expectedRelativePath,
    };
  }
  const raw = readJsonIfExists(info.path);
  if (!raw || raw.__parseError) {
    return {
      period,
      available: false,
      reasonCode: 'STATUS_FILE_UNREADABLE',
      reason: `${info.relativePath} 读不出来或不是合法 JSON`,
      statusSource: info.source,
      sourcePath: info.relativePath,
    };
  }
  let stages;
  let state;
  try {
    state = determineFaqOperatorState(raw);
    stages = describeFaqStages(raw);
  } catch (error) {
    return {
      period,
      available: false,
      reasonCode: 'STATUS_FILE_INCONSISTENT',
      reason: `快照自身矛盾，无法判定进度：${error.message}`,
      statusSource: info.source,
      sourcePath: info.relativePath,
    };
  }
  const checkedAt = typeof raw.checkedAt === 'string' ? raw.checkedAt : null;
  const ageMs = checkedAt ? Math.max(0, now - Date.parse(checkedAt)) : null;
  return {
    period,
    available: true,
    statusSource: info.source,
    sourcePath: info.relativePath,
    status: state.status,
    nextAction: state.nextAction,
    blocker: state.blocker ?? null,
    checkedAt,
    ageMs,
    // DONE 的周期不存在「快照过期」这个问题（没有在跑的东西），所以只对未完成的周期计较。
    stale: Boolean(ageMs !== null && ageMs > STALE_AFTER_MS && state.status !== 'DONE'),
    stageCounts: {
      done: stages.filter((stage) => stage.complete).length,
      total: stages.length,
      current: stages.filter((stage) => stage.current).length,
    },
    stages,
    evidence: {
      rawRecords: raw.rawRecords ?? null,
      topicRecords: raw.topicRecords ?? null,
      operatorRecords: raw.operatorRecords ?? null,
      top5Count: raw.top5Count ?? null,
    },
  };
}

// 一期只有 FAQ 一条链有阶段清单（G5/G6）。其它链不许编（§5.2 末），
// 所以这里如实只返回 FAQ，并在响应里写明「为什么只有一条」。
export function buildRunsPayload({ runtimeRoot = RUNTIME_ROOT, repoRoot = REPO_ROOT, now = Date.now() } = {}) {
  const periods = listPeriods({ runtimeRoot, repoRoot });
  const runs = periods.map(({ period, ...info }) => shapeRun(period, info, { now }));
  return {
    generatedAt: new Date().toISOString(),
    defaultPeriod: periods.find(({ source }) => source)?.period ?? periods[0]?.period ?? null,
    availableChains: [{ key: 'faq', label: 'FAQ 分析链', stageList: true, statusFiles: 'runtime/faq-analysis/<周期>/operator-status.json' }],
    missingChains: [
      { key: 'dailyReport', label: '日报链', reason: '还没有 operator CLI（G6），也完全没有登录态判定（G2）' },
      { key: 'weekly', label: '周更链', reason: '没有 operator CLI 与阶段表（G6/G5）' },
      { key: 'competitor', label: '竞品导出链', reason: '没有 operator CLI 与阶段表（G6/G5）' },
    ],
    runs,
  };
}
