// 客户配置层：把「换机器 / 换租户必须改代码」的那几项收进一份 JSON。
//
// 形状照 runtime/browser-ports.mjs：冻结常量 + 显式解析函数 + 非法值直接抛错。
//
// ---------------------------------------------------------------------------
// 最重要的一条设计约束：**没有配置文件时，行为与从前逐字相同。**
// ---------------------------------------------------------------------------
// 为什么它是硬约束，而不是「尽量」：
//   runtime/feishu-targets.mjs 被 31 个文件反向 import（含 16 个生产文件）。
//   任何「默认值悄悄变了」都会立刻改变生产行为，而且是**静默**的 ——
//   这正是本项目坑 35（默认值即目标）的形状。
//   所以本模块的缺省语义是「什么也不做」，而不是「填一套更合理的新默认」。
//   配置文件不存在 ⊂ 正常情况（开发机就是这样），不是错误。
//
// 另一个刻意的选择：**允许的字段从内置登记表推导**，不在这里写第二份字段名单。
//   写两份的下场是「配置里加了个字段，忘了同步这里，于是它被静默忽略」——
//   现场表现是「我明明配了，怎么没生效」。所以未知字段一律报错，而「已知」
//   的判据就是内置 profile 自己有哪些键。
//
// 与浏览器侧的关系（避免误读）：
//   profile 目录与 Edge 路径**不在这里**。它们已经由
//   `PROJECT_BROWSER_PROFILE` / `PROJECT_BROWSER_EXE` 覆盖（见 runtime/browser-ports.mjs
//   与两个 start-*-browser.mjs）。把已经能配的东西再包一层，只会多一条会漂移的路径。

import { readFileSync } from 'node:fs';
import path from 'node:path';

// 配置文件路径。相对路径按**仓库根**解析（而不是 cwd）：
// 这个仓库的脚本既有从根跑的、也有从 skills/<name>/ 跑的，按 cwd 解析会让
// 「同一份配置、换个目录就找不到」变成一个随机故障。
export const CONFIG_PATH_ENV = 'SYCM_CUSTOMER_CONFIG';
export const DEFAULT_CONFIG_RELATIVE_PATH = 'config/customer.json';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');

export function configFilePath(env = process.env, root = REPO_ROOT) {
  const raw = env?.[CONFIG_PATH_ENV];
  const explicit = raw === undefined || raw === null || String(raw).trim() === ''
    ? null
    : String(raw).trim();
  const target = explicit ?? DEFAULT_CONFIG_RELATIVE_PATH;
  return path.isAbsolute(target) ? path.normalize(target) : path.resolve(root, target);
}

// 读配置。三种结果要分得清楚（这是「空结果必须能被读成真的没问题」的落地）：
//   present:false  —— 没有配置文件。**正常情况**，等价于「全部用内置值」。
//   抛错            —— 文件在、但内容坏了。绝不降级成「用内置值」：
//                      那会把「配置写错了」变成「配置没生效但没人知道」。
export function loadCustomerConfig({ env = process.env, read = readFileSync, root = REPO_ROOT } = {}) {
  const file = configFilePath(env, root);
  let text;
  try {
    text = read(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
      return { present: false, file, config: null };
    }
    throw error;
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`客户配置 ${file} 不是合法 JSON：${error.message}`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`客户配置 ${file} 的顶层必须是 JSON 对象`);
  }

  const KNOWN_SECTIONS = ['feishu'];
  for (const key of Object.keys(parsed)) {
    if (!KNOWN_SECTIONS.includes(key)) {
      throw new Error(
        `客户配置 ${file} 里有未知的顶层段 "${key}"（可用：${KNOWN_SECTIONS.join(', ')}）`,
      );
    }
  }
  return { present: true, file, config: parsed };
}

// 叶子覆盖：类型必须与内置值一致。
// 不做「字符串化的数字/布尔」宽容 —— 那种宽容正是「配了但没生效」的温床。
function overlayLeaf(builtin, value, where) {
  if (builtin === null) {
    if (value === null || (typeof value === 'string' && value.trim() !== '')) return value;
    throw new Error(`${where} 必须是字符串或 null，收到 ${JSON.stringify(value)}`);
  }
  if (typeof builtin === 'string') {
    if (typeof value !== 'string' || value.trim() === '') {
      throw new Error(`${where} 必须是非空字符串，收到 ${JSON.stringify(value)}`);
    }
    return value;
  }
  if (typeof builtin === 'boolean') {
    if (typeof value !== 'boolean') {
      throw new Error(`${where} 必须是 true/false，收到 ${JSON.stringify(value)}`);
    }
    return value;
  }
  throw new Error(`${where} 的内置值类型（${typeof builtin}）不支持覆盖`);
}

// 逐层覆盖一个 profile。允许的键 = 内置 profile 自己的键（见文件头「另一个刻意的选择」）。
// 返回新对象并冻结：PROFILES 是冻结的，覆盖结果也必须冻结，
// 否则「运行时改得动目标」会成为一个新的静默失效点（feishu-targets.test.mjs 盯着这件事）。
export function overlayProfile(builtin, overrides, { where } = {}) {
  const label = where ?? '客户配置';
  if (overrides === undefined || overrides === null) return builtin;
  if (typeof overrides !== 'object' || Array.isArray(overrides)) {
    throw new Error(`${label} 必须是一个对象`);
  }

  const merged = { ...builtin };
  for (const [key, value] of Object.entries(overrides)) {
    if (!Object.hasOwn(builtin, key)) {
      throw new Error(
        `${label} 里有未知字段 "${key}"（可用：${Object.keys(builtin).join(', ')}）`
          + ' —— 拼错的字段名会被静默忽略，所以这里直接报错',
      );
    }
    const current = builtin[key];
    const isPlainObject = current !== null && typeof current === 'object' && !Array.isArray(current);
    merged[key] = isPlainObject
      ? overlayProfile(current, value, { where: `${label}.${key}` })
      : overlayLeaf(current, value, `${label}.${key}`);
  }
  return Object.freeze(merged);
}

// 校验整个 feishu 段：**在第一次访问配置时就炸**，而不是等某条链跑到一半才发现。
//   knownProfiles —— 由调用方传入（feishu-targets.mjs 的 PROFILES 键）。
//   反过来让本模块 import feishu-targets 会形成循环依赖，所以用参数注入。
export function validateFeishuOverrides(config, { knownProfiles, file = '客户配置' } = {}) {
  const section = config?.feishu;
  if (section === undefined) return;
  if (section === null || typeof section !== 'object' || Array.isArray(section)) {
    throw new Error(`${file} 的 feishu 段必须是对象`);
  }
  for (const name of Object.keys(section)) {
    if (!knownProfiles.includes(name)) {
      throw new Error(
        `${file} 的 feishu 段里有未知 profile "${name}"（可用：${knownProfiles.join(', ')}）`,
      );
    }
  }
}
