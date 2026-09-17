// 日报链的两个「旁证」：这份产物落在哪一代、这次跑在什么环境里。
//
// 为什么独立成模块（2026-09-17 复盘）：这两件事原先只有 run-daily-report.mjs 一个人回答，
// 于是 run-inquiry-backfill.mjs 既没有环境旁证，也自己拼了一个「按日期取名」的证据目录 ——
// 同一天跑两遍就覆盖上一遍。两个写入方必须对这两件事给出同一个答案，
// 所以答案只能有一份（这条纪律与 runtime/browser-ports.mjs 的存在理由是同一个）。
import { readdirSync } from 'node:fs';

// --- 一、证据目录的代次 -----------------------------------------------------
//
// 默认目录只按 reportDate 取名（evidence/daily-report-2026-09-16），所以同一天第二次跑会
// **静默覆盖**第一次的 plan/paste/receipt。2026-09-17 真的发生过，而且后果是隐性的：
// 那次目录里的 plan.json 属于后一次跑，而 before/after-import-readback.json 属于清理前的
// 那一次 —— 一个目录里装着两代产物，描述的还不是同一批记录，事后从文件名上完全看不出来。
//
// 规则（确定性，不问人）：调用方显式给了目录就原样用（那是他的选择，脚本不替他改名）；
// 否则按 policy 分两种：
//   - 'fresh'（默认，run-daily-report 用）：`evidence/daily-report-<date>` 已被占就顺延
//     `-rerun2`、`-rerun3`… 沿用 2026-09-17 手工用过一次的 `-rerun2` 命名，历史目录不用动。
//   - 'latest'（run-inquiry-backfill 用）：**并入当前最新一代**。这条链的两步是一次运行的两个
//     阶段，产物必须落在同一个目录里；如果回填也按 'fresh' 走，它就会在第一天的第二次跑里
//     被推到 -rerun3、把 plan/receipt 和自己拆散。
//
// 判据是「目录里有没有东西」，不是「几个已知文件名在不在」：只按文件名判的话，
// 截图与探针这类额外产物会绕过它 —— 而那恰恰是最该保住的证据。
export function dirHasEntries(dir) {
  try {
    return readdirSync(dir).length > 0;
  } catch {
    return false;
  }
}

export function resolveEvidenceDir(options = {}) {
  const { baseDir } = options;
  if (typeof baseDir !== 'string' || baseDir === '') throw new Error('resolveEvidenceDir requires a baseDir');
  const isOccupied = options.isOccupied ?? dirHasEntries;
  const policy = options.policy ?? 'fresh';
  if (!['fresh', 'latest'].includes(policy)) throw new Error(`unknown evidence policy: ${policy}`);
  if (options.explicit) return { dir: options.explicit, generation: null, reason: 'explicit' };
  if (policy === 'latest') {
    let dir = baseDir;
    let generation = 1;
    for (let next = 2; next <= 99; next += 1) {
      const candidate = `${baseDir}-rerun${next}`;
      if (!isOccupied(candidate)) break;
      dir = candidate;
      generation = next;
    }
    return { dir, generation, reason: 'latest' };
  }
  if (!isOccupied(baseDir)) return { dir: baseDir, generation: 1, reason: 'base-empty' };
  for (let generation = 2; generation <= 99; generation += 1) {
    const candidate = `${baseDir}-rerun${generation}`;
    if (!isOccupied(candidate)) return { dir: candidate, generation, reason: 'base-occupied' };
  }
  throw new Error(`no free evidence generation for ${baseDir} (already up to -rerun99)`);
}

// --- 二、环境旁证 ----------------------------------------------------------
//
// 「这次是在什么环境里跑的」。2026-09-17 实测的代价：日报浏览器实际跑在退役端口上，
// 可就因为收据不含环境字段，这件事**无法从任何产物自证** —— 只能靠口头交接，
// 下一个复盘的人看到的收据是干净的，会以为一切按登记表跑。
//
// 这里只观测、不裁决：值不是合法端口就如实记成 env-invalid，而不是抛错。
// runner 自己并不读这些端口（是浏览器链在用）；让一次数据导入因为一个无关的环境变量
// 而失败，是把两件事绑在一起了。真正要用它的地方（启动器）才该 fail-closed。
export function describeObservedPort(envName, registryDefault, env = process.env) {
  const raw = env?.[envName];
  if (raw === undefined || raw.trim() === '') {
    return { port: registryDefault, source: 'registry-default', registryDefault };
  }
  const parsed = Number(raw);
  const valid = Number.isInteger(parsed) && parsed > 0 && parsed <= 65535;
  return valid
    ? { port: parsed, source: 'env', registryDefault }
    : { port: null, source: 'env-invalid', raw, registryDefault };
}

export function describeObservedIdentity(envName, registryDefault, env = process.env) {
  const raw = env?.[envName];
  return raw === undefined || raw.trim() === ''
    ? { id: registryDefault, source: 'registry-default' }
    : { id: raw, source: 'env' };
}

// --- 三、页面模型的单元格 → 人读的值 ---------------------------------------
//
// 为什么单独拎成一个可测函数：这是本文件里唯一「错了也不会抛错、只会安静地印出错误证据」
// 的逻辑。2026-09-17 的实例 —— 回读结果里「店铺」那一列印的是 `optIYzOzu2`（选项 id），
// 读证据的人得自己去猜这是哪家店，而它看起来完全像一个正常的值。
//
// 根因是两套表示：**页面模型存 SingleSelect 的选项 id，OpenAPI 存选项的名字**。
// 所以从页面读回来的东西必须显式映射一次；映射不出来就如实标出来，不许把 id 冒充成名字。
// 同一个 id 在不同字段里指向不同名字时（optionAmbiguous）也要标出来 —— 那种情况下的
// 「映射成功」是假的，宁可让人看见原始 id。
export function resolveOptionToken(token, optionName = {}, optionAmbiguous = {}) {
  if (token === null || token === undefined) return null;
  if (typeof token === 'string' && Object.hasOwn(optionName, token)) {
    return optionAmbiguous[token]
      ? { value: token, display: token, resolvedBy: 'ambiguous-option-id' }
      : { value: token, display: optionName[token] ?? token, resolvedBy: 'option-id' };
  }
  if (typeof token === 'object') {
    const inner = token.text ?? token.name ?? token.value ?? null;
    return inner === null ? null : { value: inner, display: inner, resolvedBy: null };
  }
  return { value: token, display: token, resolvedBy: null };
}

// 端口与身份都从 runtime/browser-ports.mjs 取默认值（唯一来源）；
// 这里只负责「把实际观测到的东西连同出处写下来」。
export function buildEnvironment(options = {}) {
  const env = options.env ?? process.env;
  const ports = options.ports;
  const identities = options.identities;
  if (!ports || !identities) throw new Error('buildEnvironment requires { ports, identities }');
  return {
    computedAt: new Date().toISOString(),
    node: process.version,
    proxyUrl: options.proxyUrl ?? null,
    browserPort: describeObservedPort('CDP_BROWSER_PORT', ports.browser, env),
    proxyPort: describeObservedPort('CDP_PROXY_PORT', ports.proxy, env),
    browserId: describeObservedIdentity('CDP_BROWSER_ID', identities.id, env),
    browserLabel: describeObservedIdentity('CDP_BROWSER_LABEL', identities.label, env),
  };
}
