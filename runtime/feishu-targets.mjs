// 飞书目标单一事实来源：逻辑名 → base / table id / 凭据文件。
//
// 背景：搬迁到新租户（kcne618basvj）后，竞品 base 与四张稳定表的 id 全变了。
// 活跃脚本不应各自硬编码 id，也不应各自硬编码 env 文件路径——两边漂移会让
// 「跑的是哪个租户」变成需要靠记忆判断的事（迁移 8 的 D8.10 已经把同类问题
// 在运行器装配上收过一次，这里是同一原则在飞书目标上的应用）。
//
// 选择租户：环境变量 SYCM_FEISHU_PROFILE，接受 profile 名或别名；
// 不设时用 DEFAULT_PROFILE。
//
// 注意：`weekly` 表（竞品周 / SKU周 / 问题库）**不在本文件里**——它们每周新建，
// id 天然会过期。按名字在运行时解析（见 weekly-table-target.mjs）。
import { readFileSync } from 'node:fs';

import {
  loadCustomerConfig,
  overlayProfile,
  validateFeishuOverrides,
} from './customer-config.mjs';

const STABLE_TABLE_KEYS = ['competitorMain', 'skuDetail', 'history', 'questionMaster'];

export const PROFILES = Object.freeze({
  legacy: Object.freeze({
    label: '旧租户 rcndesfqro3x',
    host: 'rcndesfqro3x.feishu.cn',
    envFile: 'E:/小红书/.env.local',
    competitorBase: 'OWebbPUcBa7B8JseYLccQCy9nkf',
    keywordBase: 'N21Abkg0HakO6AsbCaDckvcwnVd',
    // 2026-09-14 实测：新应用在旧 base 上可建表（写权限已验证）
    writeVerified: true,
    tables: Object.freeze({
      competitorMain: 'tblJ9LHFN6pMVjPv',
      skuDetail: 'tblddWTrPeB4TKmR',
      history: 'tblH0bmmOuogxDHi',
      questionMaster: 'tblCrsUpiVlpWjVw',
    }),
  }),
  kcne: Object.freeze({
    label: '新租户 kcne618basvj',
    host: 'kcne618basvj.feishu.cn',
    envFile: 'E:/小红书/.env.feishu-kcne.local',
    // 2026-09-15 切到用户指定的正式 base「浴缸竞品分析」。
    // 切换前指向的是迁移期测试副本 OUMqbkYwVaQxQNsv2EDc1DV7nDf（「浴缸竞品分析 V2（测试） 副本」）。
    // 两者登记行数逐表相同（竞品主表 2004 / SKU明细 734 / 历史总表 4346 / 问题主库 2023 /
    // 竞品周_2026-09-06_2026-09-12 1462），所以这次不是数据迁移，而是「指向 + 写权限复验」。
    // 回滚 = 把 competitorBase 与下面四个表 id 换回：
    //   OUMqbkYwVaQxQNsv2EDc1DV7nDf
    //   competitorMain tbl94WyAsVNdMkJf / skuDetail tbltI9UufhunLc3u
    //   history tblktwxWKt8sjpXL / questionMaster tbl37PRcIXQCtfYk
    competitorBase: 'QcnhbEzYpacGvUskCbVcrcm3nFd',
    // 关键词库也搬了：旧租户那张的副本，2026-09-14 核对 8 张表字段签名与行数逐表相同
    keywordBase: 'HdBhbttB5aScbasWJAMc0gGXnpe',
    dailyReport: Object.freeze({
      baseToken: 'X02Xb7fHba7mU9sr8uIcRlExn6b',
      sourceTable: 'tbl84ZGwLQKyLxV3',
      sourceView: 'vewwg0rhjo',
      inquiryTable: 'tblm9Hx7R9A1YoLC',
    }),
    // 2026-09-15 实测：用户把应用加为「浴缸竞品分析」的可编辑协作者后，
    // 幂等写探针（把历史总表的「平台」写成它当前的值）由 403/91403 变成 **HTTP 200 / code 0**。
    // 这就是「这个 base 的写权限已验证」的证据，所以置 true。
    // 仍然保留这条纪律：换 base 必须重新验证，别把旧 base 的结论搬过来。
    writeVerified: true,
    tables: Object.freeze({
      competitorMain: 'tblkYcczxBnW4v5G',
      skuDetail: 'tbl3N48H4znz304T',
      history: 'tbln7qqA6XopiL4Q',
      questionMaster: 'tblbJ9F91NiN8IfO',
    }),
    // 2026-09-15 修正：switch 到正式 base 时这里漏改，留下了上一个 base 的「数据表」id，
    // 而正式 base「浴缸竞品分析」根本没有这张表（只读列举 10 张表，无「数据表」）→ 悬空引用。
    // 正式 base 不做演练写入：要空表就往周表体系里新建带名字的表，别指望有个通用 scratch。
    scratchTable: null,
  }),
});

export const PROFILE_ALIASES = Object.freeze({
  legacy: 'legacy',
  old: 'legacy',
  rcndesfqro3x: 'legacy',
  kcne: 'kcne',
  new: 'kcne',
  kcne618basvj: 'kcne',
});

// 切换租户时改这一行（同时 .workbuddy/memory/MEMORY.md 与 docs/ops/TENANT-MIGRATION-MAP.md 一起改）。
// 2026-09-14 已切到 kcne：旧租户废弃，新租户的读/写双向验证均通过（见 TENANT-MIGRATION-MAP §5.3）。
// 回滚 = 把这一行改回 'legacy'，不需要动任何业务脚本。
export const DEFAULT_PROFILE = 'kcne';

export const PROFILE_ENV_VAR = 'SYCM_FEISHU_PROFILE';

export { STABLE_TABLE_KEYS };

export function resolveProfileName(name) {
  // 空值（含空串）不是「一个名字」：shell 里 `SYCM_FEISHU_PROFILE=` 这种写法很常见，
  // 让它回落默认值，而不是让每个脚本都在启动时炸掉。
  const raw = name === null || name === undefined || String(name).trim() === '' ? DEFAULT_PROFILE : name;
  const resolved = PROFILE_ALIASES[String(raw).trim()];
  if (!resolved) {
    throw new Error(`Unknown Feishu profile: ${raw} (known: ${Object.keys(PROFILE_ALIASES).join(', ')})`);
  }
  return resolved;
}

export function activeProfileName(env = process.env) {
  return resolveProfileName(env?.[PROFILE_ENV_VAR] ?? DEFAULT_PROFILE);
}

// 客户配置的进程内缓存。
// 为什么缓存而不是每次都读文件：getProfile() 被 tableId / baseUrl / envFilePath 这类
// 访问器反复调用（逐行解析时常见的是每行一次）。
// 为什么仍留一个重置入口：运维改了配置想让常驻进程生效时不必重启；
// 测试改了环境变量后也能拿到干净状态，而不是依赖「测试执行顺序恰好合适」。
let cachedCustomerConfig;
export function resetCustomerConfigCache() {
  cachedCustomerConfig = undefined;
}

function activeCustomerConfig() {
  if (cachedCustomerConfig === undefined) {
    const { present, config, file } = loadCustomerConfig();
    // 配置写错要在**第一次访问时就炸**，而不是等某条链跑到一半才发现。
    if (present) validateFeishuOverrides(config, { knownProfiles: Object.keys(PROFILES), file });
    cachedCustomerConfig = config;
  }
  return cachedCustomerConfig;
}

// 这是客户配置层**唯一**的接入点：所有访问器（profileTargets / tableId / envFilePath /
// competitorBaseToken / keywordBaseToken / dailyReportTargets / baseUrl / loadFeishuCredentials）
// 都经过它，所以「把凭据路径与 base/表 id 从代码里挪出来」只改了这一个函数。
//
// 无客户配置时 overlayProfile 原样返回 PROFILES[key] —— 默认行为逐字不变。
export function getProfile(name, { config = activeCustomerConfig() } = {}) {
  const key = resolveProfileName(name);
  return overlayProfile(PROFILES[key], config?.feishu?.[key], { where: `客户配置 feishu.${key}` });
}

// 精简视图：脚本多数只关心这几个值，给一个不再需要二次解引用的形状。
export function profileTargets(name) {
  const profile = getProfile(name);
  return Object.freeze({
    name: resolveProfileName(name),
    label: profile.label,
    host: profile.host,
    envFile: profile.envFile,
    baseToken: profile.competitorBase,
    baseUrl: `https://${profile.host}/base/${profile.competitorBase}`,
    keywordBase: profile.keywordBase,
    writeVerified: profile.writeVerified,
    tables: profile.tables,
  });
}

export function competitorBaseToken(name) {
  return getProfile(name).competitorBase;
}

// 关键词库是另一张独立 base（复制竞品 base 不会带上它），所以有独立访问器。
export function keywordBaseToken(name) {
  return getProfile(name).keywordBase;
}

export function dailyReportTargets(name) {
  const target = getProfile(name).dailyReport;
  if (!target) throw new Error(`Daily-report target is not configured for profile: ${resolveProfileName(name)}`);
  return target;
}

export function tableId(logicalName, name) {
  const tables = getProfile(name).tables;
  if (!Object.hasOwn(tables, logicalName)) {
    const known = Object.keys(tables).join(', ');
    throw new Error(`Unknown Feishu table logical name: ${logicalName} (known: ${known})`);
  }
  return tables[logicalName];
}

export function envFilePath(name) {
  return getProfile(name).envFile;
}

export function baseUrl(name) {
  const profile = getProfile(name);
  return `https://${profile.host}/base/${profile.competitorBase}`;
}

export function parseEnvFile(text) {
  const values = {};
  for (const rawLine of String(text ?? '').split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator < 1) continue;
    let value = line.slice(separator + 1).trim();
    if (/^".*"$/u.test(value) || /^'.*'$/u.test(value)) value = value.slice(1, -1);
    values[line.slice(0, separator).trim()] = value;
  }
  return values;
}

export function loadFeishuCredentials(name, { read = readFileSync } = {}) {
  const file = envFilePath(name);
  const values = parseEnvFile(read(file, 'utf8'));
  const appId = values.FEISHU_APP_ID;
  const appSecret = values.FEISHU_APP_SECRET;
  if (!appId || !appSecret) {
    throw new Error(`env file ${file} must define FEISHU_APP_ID and FEISHU_APP_SECRET`);
  }
  return { appId, appSecret, file, values };
}
