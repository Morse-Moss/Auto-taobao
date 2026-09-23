// 系统版本号：**唯一来源是仓库根的 `VERSION` 文件**（纯文本，一行，形如 `1.0.0`）。
//
// 为什么需要一个模块，而不是各处直接读文件（2026-09-23 用户要求「我们的系统开发必须要有版本号」）：
//   1) **版本号必须出现在日志与诊断包里** —— `docs/ops/CLIENT-DESKTOP-DELIVERY-PLAN.md` P0-6
//      的诊断包规格第一条就是「版本 ＋ 最近回执 ＋ 关键日志 ＋ 截图」；
//      `docs/architecture/EXTENSIBILITY-AND-DEPLOYMENT-PROPOSAL.md` §4.3 的 Decision 段也写着
//      「必须引用输入证据与**版本**」。两处都要它，所以它得有一个可被 import 的出口。
//   2) **判据要能离线跑。** 读文件那一步是 I/O，解析与校验是纯函数 —— 与仓库其它地方同一条分界。
//
// 三条口径（都是本仓库反复吃过的坑的形状）：
//   · **读不到／解析不出来就抛错，不许回落成 `'unknown'`。**
//     一个「版本：unknown」的诊断包，与一个没有版本的诊断包一样没用；而它会让人以为读过了。
//     （同源教训：`login-merchant` 的 `null` 不许算「已登录」。）
//   · **格式当场校验**（fail-closed）。`VERSION` 里写 `v1.0` 或 `1.0.0 ` 这种都要么被规范化、
//     要么当场报错 —— 静默接受会让「1.0.0」与「1.0」在比较时变成两个不同的东西。
//   · **只有这一个来源。** `package.json` 的 `version` 与 `CHANGELOG.md` 的第一条都必须与它一致，
//     由 `runtime/version-consistency.test.mjs` 守着；三处各写一遍正是技术债 E1 的成因。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** 版本号文件（相对仓库根）。 */
export const VERSION_FILE = 'VERSION';

/** 仓库根：本模块在 `runtime/` 下，向上一级。 */
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// 语义化版本 x.y.z，允许 `-rc.1` 这种预发布后缀（本项目目前不用，但不想把它变成「非法」）。
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;

/**
 * 解析 `VERSION` 文件的内容。**纯函数**。
 *
 * 允许首尾空白与结尾换行（文件里写一行是常态），但**不接受** `v` 前缀 ——
 * 那会让 `v1.0.0` 与 `1.0.0` 在字符串比较里不相等，而它们显然是同一个版本；
 * 与其在两处各判一次，不如在入口就把口径收紧。
 */
export function parseVersion(text) {
  const value = String(text ?? '').trim();
  if (!value) {
    throw new Error('版本号是空的：仓库根的 VERSION 文件里必须有一行 x.y.z');
  }
  if (!VERSION_PATTERN.test(value)) {
    throw new Error(`版本号格式不对：${JSON.stringify(value)}（要 x.y.z 形式，例如 1.0.0；不要 v 前缀）`);
  }
  return value;
}

/**
 * 读版本号。**I/O**。
 *
 * `root` 与 `readFile` 都可注入，所以用例不用碰真实文件；生产调用不传就是仓库根与 `fs`。
 * 读不到文件时抛错（而不是返回 null）—— 见文件头第 1 条口径。
 */
export function readVersion({ root = REPO_ROOT, readFile = fs.readFileSync, file = VERSION_FILE } = {}) {
  const full = path.join(root, file);
  let text;
  try {
    text = readFile(full, 'utf8');
  } catch (error) {
    throw new Error(`读不到版本号文件 ${full}：${String(error?.message ?? error)}`);
  }
  return parseVersion(text);
}

/** 取版本号，读不到就抛错。给「必须在日志/诊断包里写出自己是谁」的地方用。 */
export function currentVersion(options = {}) {
  return readVersion(options);
}

/**
 * 一行「我是谁、什么版本」。日志与诊断包都该有这一行 ——
 * 事后拿到一份日志，第一个问题永远是「这是哪一版跑出来的」。
 *
 * 读不到就抛错（与 `readVersion` 同一条口径）：要版本的地方都是「必须有答案」的地方。
 */
export function versionLine({ component = 'sycm-automation', ...options } = {}) {
  return `${component} ${readVersion(options)}`;
}

/**
 * 与 `versionLine` 同一行文字，但**永不抛错**。给「不能因为一行日志就整天不干活」的调用点用。
 *
 * 为什么要有第二个出口：把两种需求混成一个函数，必然要选一边。
 *   · 判据与诊断包要的是**准** —— `VERSION` 丢了就该当场红（→ `versionLine`）。
 *   · 定时任务入口要的是**活着** —— 记不清自己是第几版，是记账问题；
 *     为了记账问题停掉一天的采集，是把小错升级成业务停摆（→ 本函数）。
 *
 * 关键在失手时的措辞：它落的是 `… unknown（读不到版本号文件 …）`，**原因一起写进同一行**。
 * 于是「日志里读到 unknown」永远伴随一句为什么，不会像静默回落那样被人当成正常输出
 * （这正是 `readVersion` 第一条口径要防的那件事）。
 */
export function versionLineSafe({ component = 'sycm-automation', ...options } = {}) {
  try {
    return `${component} ${readVersion(options)}`;
  } catch (error) {
    return `${component} unknown（${String(error?.message ?? error)}）`;
  }
}
