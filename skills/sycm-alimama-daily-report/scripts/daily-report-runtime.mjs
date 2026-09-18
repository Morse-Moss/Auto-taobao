// 日报链的两个「旁证」：这份产物落在哪一代、这次跑在什么环境里。
//
// 为什么独立成模块（2026-09-17 复盘）：这两件事原先只有 run-daily-report.mjs 一个人回答，
// 于是 run-inquiry-backfill.mjs 既没有环境旁证，也自己拼了一个「按日期取名」的证据目录 ——
// 同一天跑两遍就覆盖上一遍。两个写入方必须对这两件事给出同一个答案，
// 所以答案只能有一份（这条纪律与 runtime/browser-ports.mjs 的存在理由是同一个）。
import { readdirSync } from 'node:fs';
import path from 'node:path';

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

// --- 一之二、目录名里带不带「店铺」这一维 -----------------------------------
//
// 为什么（2026-09-18 一轮多店铺实测）：这套产物目录原先**只按报告日取名**，没有店铺维度，
// 而 `--commit` 与回填都用 policy:'latest'（并入当前最新一代）⇒ 四家店串行跑时，后一家的
// `plan.json` / `paste.tsv` / `receipt.json` 会**覆盖**前一家的同名文件，
// 一个目录里最后只剩最后一家。那一轮因此真实丢了 5 个文件的本地副本
// （业务事实一件没丢：stdout 台账、审计表、两条独立回读都在）。
//
// 这是同一个缺口的第三次出现：`PROJECT_PORTS` 缺店铺维 → 查询键缺店铺维 → 现在是产物路径。
//
// **默认行为逐字不变**：不给 shopKey 时返回的仍然是 `daily-report-<日期>`——
// 单店跑与所有历史目录一个字都不用改，多店铺显式给 `--shop-key` 才拿到店铺维度。
// 这跟「新能力默认关闭地接进已经在跑的编排器」是同一条纪律：
// 装上它不该改变任何既有调用方的行为，否则「接错」会伪装成「升级」。
//
// 三个写入方（push / 回填 / 独立回读）原先各自拼了一遍同样的字符串，也正是「同一个答案只能有一份」
// 这条纪律要消掉的东西 —— 现在它们共用这一个函数。
export const SHOP_KEY_PATTERN = /^[\p{L}\p{N}_.-]+$/u;

export function evidenceBaseDir(options = {}) {
  const { evidenceRoot, reportDate, shopKey = null } = options;
  if (typeof evidenceRoot !== 'string' || evidenceRoot === '') {
    throw new Error('evidenceBaseDir requires an evidenceRoot');
  }
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(String(reportDate ?? ''))) {
    throw new Error(`invalid report date for evidence dir: ${JSON.stringify(reportDate)}`);
  }
  const dated = `daily-report-${reportDate}`;
  if (shopKey === null || shopKey === undefined || String(shopKey).trim() === '') {
    return path.join(evidenceRoot, dated);
  }
  // 这个键会进**目录名**，所以字符集要收窄：它一次堵掉两件事 ——
  // ① `..`／路径分隔符这类「写到别的目录去」的入口；
  // ② 一堆看不见的字符（空格、控制符、引号）进目录名之后在各处工具里表现不一致。
  // 「两家店填了同一个键」这另一种撞车它堵不住，那一半由 `assertShopKeyMatchesSource`
  // （键必须与源产物里的店名一致）来堵。
  const key = String(shopKey).trim();
  if (!SHOP_KEY_PATTERN.test(key) || key === '.' || key === '..') {
    throw new Error(`invalid shop key for evidence dir: ${JSON.stringify(shopKey)}`);
  }
  return path.join(evidenceRoot, `${dated}-${key}`);
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
// 根因是两套表示：**页面模型存 SingleSelect 的选项 id，OpenAPI 存选项的名字**，
// 所以从页面读回来的东西必须显式映射。但「有一张 id→名字 的表」还不够 ——
// 2026-09-17 第二次踩到：同一个 opt id 在询单表叫「盖文淘宝」、在月度表里只写「盖文」，
// 于是「全 base 扫一遍」会把 12 家店里的 5 家判成歧义、退回原始 id。
// 正确做法是**分层**，顺序就是优先级，每层都要在结果里写明用了哪一层：
//
//   1. 单元格**所属字段自己的**选项表 —— 精确，不可能有歧义（询单表的「店铺」走这层）；
//   2. 指定的权威表（询单表的「店铺」字段）—— 给派生/Lookup 字段用，它们自己没有选项，
//      值是从别处取来的 id（底单的「店铺」走这层）；
//   3. 全 base 扫描 —— 只剩这种情况才用；同名 id 指向不同名字就标 `ambiguous-option-id`
//      并**保留原始 id**，宁可让人看见 id，也不要给一个假的「映射成功」。
export function resolveFieldValue(token, options = {}) {
  if (token === null || token === undefined) return null;
  const { type, optionLayers = [] } = options;

  // 日期字段（type 5）在页面模型里是 epoch 毫秒；按 +08:00 换算，
  // 否则凌晨那几个小时会被读成前一天（本项目坑 42）。
  if (type === 5 && Number.isFinite(Number(token))) {
    const ms = Number(token);
    return { value: ms, display: new Date(ms + 8 * 3600 * 1000).toISOString().slice(0, 10),
      resolvedBy: 'epoch+08:00' };
  }

  if (typeof token === 'string') {
    for (const layer of optionLayers) {
      const map = layer?.map;
      if (!map || !Object.hasOwn(map, token)) continue;
      if (layer.ambiguous && layer.ambiguous[token]) {
        return { value: token, display: token, resolvedBy: 'ambiguous-option-id' };
      }
      return { value: token, display: map[token] ?? token, resolvedBy: layer.source ?? null };
    }
  }

  if (typeof token === 'object') {
    const inner = token.text ?? token.name ?? token.value ?? null;
    return inner === null ? null : { value: inner, display: inner, resolvedBy: null };
  }
  return { value: token, display: token, resolvedBy: null };
}

// --- 四、哪些字段「该有值却没读到」------------------------------------------
//
// 为什么必须有这一段（2026-09-17，本文件里第三个「安静地出错」的形状）：
// 回读只关心 FIELDS_OF_INTEREST 里的几个字段，取不到就 `continue` —— 于是**没有值**与
// **这个字段根本读不到**在产物里长得一模一样（都是「这一列不在」）。读者会把它读成
// 「当天没写进去」，而真实原因可能是页面模型压根不携带它。
//
// 实测（2026-09-17）：底单的「店铺」是 type 19 的 Lookup 派生字段，265 个字段里**正好缺它这一个**
// —— `record.fields` 里连键都没有（`fldsPXWgqt` 不在任何一条记录的键集里）。
// 也就是说这不是「值空了」，是「这条通路读不到派生值」，两者必须分开写：
//   - 派生字段 + 键不存在 ⇒ 结构性不可读，如实标注，并指向同表的可读替身（`店铺名称`）；
//   - 普通字段 + 键存在但值为空 ⇒ 那才是「这一格就是空的」这个业务事实。
// 判据做成纯函数（而不是写在注入的表达式里），是因为这种「错了不抛错」的逻辑只有能离线
// 单测才谈得上可靠 —— 和 resolveFieldValue 同一个理由。
export const DERIVED_FIELD_TYPES = Object.freeze({
  19: 'Lookup', 20: 'Formula', 21: 'Link',
  1001: 'CreatedTime', 1002: 'ModifiedTime', 1003: 'CreatedUser', 1004: 'ModifiedUser', 1005: 'AutoNumber',
});

export function classifyFieldCoverage(options = {}) {
  const { rows = [], fieldMeta = {}, sampleKeys = [], fieldsOfInterest = [], readableFallback = [] } = options;
  // 统计口径必须写进产物（`scope`）：整张表的「324/2197 行没有值」和目标日的
  // 「12 行里几行有值」是两件事。2026-09-17 实测：按整表报出来那条会盖过真正该看的那条
  // —— 询单表 2197 行里绝大多数是别的日期，它们没有值本来就不是问题。
  const scope = options.scope ?? null;
  const notInTable = [];
  const absentFields = [];
  for (const name of fieldsOfInterest) {
    const field = fieldMeta[name];
    if (!field) { notInTable.push(name); continue; }
    // 一行都没有就无从统计「多少行没有值」，只能标 evaluated=false，不许当成「都读到了」。
    if (rows.length === 0) continue;
    const rowsWithoutValue = rows.filter((row) => !row?.values?.[name]).length;
    if (rowsWithoutValue === 0) continue;
    const keyPresentInRecordFields = sampleKeys.includes(field.id);
    const derived = DERIVED_FIELD_TYPES[field.type];
    const reason = derived && !keyPresentInRecordFields ? `${derived}-key-absent-from-page-model`
      : derived ? `${derived}-value-null-in-page-model`
        : keyPresentInRecordFields ? 'null-in-page-model' : 'field-key-absent-from-page-model';
    const entry = { name, fieldId: field.id, type: field.type, rowsWithoutValue, rowsObserved: rows.length,
      scope, keyPresentInRecordFields, reason };
    if (derived && !keyPresentInRecordFields) {
      entry.note = `页面模型在 record.fields 里根本不带这个派生字段（${derived} / type ${field.type}）`
        + '⇒ 该列在回读里必然为空，不能读成「当天没写进去」'
        + (readableFallback.length ? `；权威可读值见同表的「${readableFallback.join('、')}」` : '');
    }
    absentFields.push(entry);
  }
  return { fieldsCoverageEvaluated: rows.length > 0, fieldsCoverageScope: scope, absentFields, fieldsNotInTable: notInTable };
}

// 把要注入页面的那几个纯函数拼成一段**自洽**的代码 —— 「自洽」在这里是硬要求。
//
// 教训（2026-09-17，现场跑才抓到）：`fn.toString()` 只带函数体，函数里引用的模块级常量
// 不会跟着走。classifyFieldCoverage 用到 DERIVED_FIELD_TYPES，于是注入到页面里立刻
// `ReferenceError: DERIVED_FIELD_TYPES is not defined`。**离线测试当时是绿的** ——
// 因为它 import 的是模块里的那一份，模块作用域是全的，看不见这个洞。
// 所以：① 依赖的常量必须一并注入；② 测试要在「只有这段代码」的环境里真的调用一次
// （见 daily-report-runtime.test.mjs 里的 new Function 沙箱），不能只做字符串比对。
export function injectedHelpersSource() {
  return [
    `const DERIVED_FIELD_TYPES = ${JSON.stringify(DERIVED_FIELD_TYPES)};`,
    `const resolveFieldValue = ${resolveFieldValue.toString()};`,
    `const classifyFieldCoverage = ${classifyFieldCoverage.toString()};`,
  ].join('\n    ');
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
