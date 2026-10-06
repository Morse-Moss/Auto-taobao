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
//
// 商品数据链的 base **按月 × 按部门**换（2026-09-30 起），那一部分不在 PROFILES 里，
// 而是下面的 PRODUCT_DATA_MONTH_BASES 注册表 —— 唯一的取目标入口是
// `productDataTargetsForShop(店铺, 数据日期)`，别再用 profile 上那个单对象。
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
    // 2026-09-18：从「各店铺日报  副本」（X02Xb7fHba7mU9sr8uIcRlExn6b）切到用户指定的正主
    // 「各店铺日报 」（PTfHbPt9Ea…）。当时两张 base 的 7 张表同名、其中 6 张逐表行数与字段签名
    // 完全相同，肉眼分辨不出，唯一的分水岭是「总数据来源底单」的行数（副本 8 行 / 正主 1873 行）。
    //
    // 2026-09-30 晚：**用户又指定换成一张叫「各店铺日报 副本」的 base**
    // （RjKcb3isDaVn1GsoVJfc7Ykknyg）。这次名字里的「副本」**不是**判错 —— 它才是全的那一张，
    // 2026-09-30 只读取证（D:/Retire/probe-20260930/base-inventory-20260930.json）：
    //   总数据来源底单  新 2184 行（04-01…09-29 每天 12 家齐）| 旧 1934 行（09-18…09-28 只剩每天 5 家）
    //   店铺底单        新 13 行（多了第 13 家「网林家居」）  | 旧 12 行
    //   各店铺数据日报  新 09-29 起每天 13 家               | 旧 每天 12 家
    // ⇒ 判据仍然是**底单行数**，不是名字；这条纪律没变，变的是哪一张更全。
    // 回滚 = 把四个值换回（并同步 feishu-targets.test.mjs 里那条「正主 vs 副本」用例）：
    //   PTfHbPt9EaIzddsfL8Jcj238nrb / 各店铺日报 / tblkY3W8tnPWPcnh / tblUnwn05vl8Wik9
    //
    // sourceBaseName 是 base 名的**第二因子**：run-daily-report.mjs 会在浏览器里读回页面所属
    // base 的名字，跟这里的值比对 —— id 抄对了而名字对不上（或反过来）都当场炸，而不是等写进去
    // 才发现写错了 base。名字与 id 存在同一个对象里，就是为了让它们不可能各自漂移。
    // 比较时两边都去空格（`normalizeBaseName`）：接口读回的名字带尾随/中间空格，
    // 这种看不见的字符不该决定写的是哪一张 base。这里存**接口读回的原文**（含「副本」两个字）。
    //
    // ⚠️ 用户给的 URL 里 `?table=blkA0FiI6um8CwmK` **不是这个 base 的任何一张数据表**：
    // OpenAPI 对它在四个相关 base 上逐个试过，一律回 `1254004 WrongTableId`；这个 base 实际只有
    // 7 张表（`tbl` 开头，逐张列在 base-inventory-20260930.json 里），也没有仪表盘。
    // 所以落位仍按**表名**取：底单＝总数据来源底单、询单＝各店铺数据日报。
    dailyReport: Object.freeze({
      baseToken: 'RjKcb3isDaVn1GsoVJfc7Ykknyg',
      sourceBaseName: '各店铺日报 副本',
      sourceTable: 'tblIuAX4nPc1zDOO',
      // 新 base 的「总数据来源底单」**只有一个视图**，而且它的 id 与旧 base 那个逐字相同
      // （vewwg0rhjo，2026-09-30 用 `GET …/tables/tblIuAX4nPc1zDOO/views` 读回）——
      // 所以这一格这次不用改。别把它当成「配置没切」的证据：id 相同是读回来的事实。
      sourceView: 'vewwg0rhjo',
      inquiryTable: 'tblqF2YD2VfmKP4C',
    }),
    // 推广日报目标必须由运营确认后登记；未登记时所有真实导入 fail-closed。
    promotionDaily: null,
    // ⚠️ 2026-09-30 起：**新代码不要再用这一格**。商品数据已改成「月份 × 部门」分 base，见下方
    // PRODUCT_DATA_MONTH_BASES 与 `productDataTargetsForShop(店铺, 数据日期)`。
    // 这一格保留的原因有二：① 它就是「2026-09 × 销售1部」那个条目（测试断言两者同源，
    // 防止两份值各自漂移）；② 尚未改造的推广链（import-promotion-data.mjs）仍在读它。
    productData: Object.freeze({
      baseToken: 'DQ2DbRinJaDx8Ss4gVFczsTXn3d',
      productTable: 'tblzyf0oLvfbvN1l',
      inquiryTable: 'tbl1hHlRX0LYMvYY',
      promotionTable: 'tblaCPQMLWAq21Gw',
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

export function promotionDailyTargets(name) {
  const target = getProfile(name).promotionDaily;
  if (!target) {
    throw new Error(`Promotion-daily target is not configured for profile: ${resolveProfileName(name)}; confirm Base/table ids first`);
  }
  return target;
}

export function productDataTargets(name) {
  const target = getProfile(name).productData;
  if (!target) throw new Error(`Product-data target is not configured for profile: ${resolveProfileName(name)}`);
  return target;
}

// ---------------------------------------------------------------------------
// 商品数据链的飞书目标：「月份 × 部门」注册表（2026-09-30 加）
// ---------------------------------------------------------------------------
// 为什么要有它：商品数据的飞书 base **按月换**，而且从 2026-10 起**还要按部门分开**
// （销售1部 / 销售2部 各一张）。上面那个 `PROFILES.kcne.productData` 是「1 个 baseToken +
// 3 个 tableId」的单对象，装不下 4 张 base / 9 个写入面；把它硬撑成数组只会把
// 「哪家店写哪张 base」这件事藏进调用方的 if-else 里。
//
// 现状（2026-09-30 只读取证，见 D:/Retire/probe-20260930/base-inventory-20260930.json）：
//   2026-09 × sales1  DQ2DbRinJaDx8Ss4gVFczsTXn3d「9月商品监控表」  ← 至今没换过
//   2026-10 × sales1  FhCUbn7vVaEc26sRjMAccQJAn5e「10月商品监控表-销售1部」
//   2026-10 × sales2  ZYwWbYP9fa5d3rsXX8IcKrkYnod「10月商品监控表-销售2部 副本」
//   2026-09 × sales2  **不存在** —— 2 部是 10 月才有的，9 月只有一张不分部门的 base。
// 10 月这两张在 2026-09-30 晚按用户给的《店铺账号信息表测试.xlsx》换过一次（那天表里
// 「对应飞书商品表格链接」一栏从旧租户 rcnbpuvafkct 的 LQgZbi78oa…/LLWcbIuVFaB… 改成了
// 新租户 kcne618basvj 的这两张，并第一次带上了 `&table=&view=`）——
// 两个旧 token 留在这里当回滚值：LQgZbi78oaAmIYsc4urcwk9rnNf / LLWcbIuVFaBm6yshX9Xc8DFZn9d。
// 2 部那张的名字里带「副本」是按接口读回的原文照抄（1 部那张不带），属于事实记账，不是笔误。
// 缺一对就 fail-closed 抛错，**绝不回落到上个月的 base**：回落的后果是「跑成功、数据写进
// 运营不看的表」，而且从收据上看不出来（坑 35「默认值即目标」的形态）。
//
// 三张被写的表在 9月/10月1部/10月2部 之间**逐字段零差异**（73 / 14 / 82 字段，**顺序也一致**）：
// 2026-09-30 用 `GET …/tables/<id>/fields` 把三张表 × 三个 base 的字段名序列逐项比对过
// （probe-20260930/field-signature-compare.json），6 组全部「逐字段（含顺序）完全一致」。
// 所以换 base 不需要动任何写入逻辑 —— 这是实测结论，不是推测。
//
// ⚠️ 推广链（`import-promotion-data.mjs`）**不读这张表**：它还没改造（用户 2026-09-30 原话
// 「推广数据这个流程我还没开发，你先放着不管」）。10 月的推广在**另一套 base**里、而且是
// 换了形状的两张表（关键词数据 78 字段 / 人群数据 74 字段），与这里登记的
// 「商品推广数据底单」不是一回事。这一格留着是为了记账，不代表推广已经接上。

/**
 * 店铺 → 部门。键与 `runtime/browser-ports.mjs` 的 `SHOP_BROWSERS` **逐项同序**：
 * 同序不是洁癖 —— `planBatches` 按那份登记表的顺序切批，顺序一致才让
 * 「一批尽量落在同一个部门的 base 上」这件事有据可依（13 家 ÷ 5 = 5/5/3，第 2 批必然跨界）。
 * 测试会把两边逐项比对，改名或调序会当场红，而不是静默漂移。
 */
export const SHOP_DEPARTMENTS = Object.freeze({
  // 销售1部（8 家）
  里可林淘宝: 'sales1',
  网林天猫: 'sales1',
  盖文淘宝: 'sales1',
  盖文天猫: 'sales1',
  科塔淘宝: 'sales1',
  网林淘宝: 'sales1',
  里可林天猫: 'sales1',
  // 2026-09-30 晚改名：`网林定制淘宝` → `网林家居`。
  // 依据是用户自己改的：当天 11:05 那版《店铺账号信息表》里这家的「飞书表格简称」写的是
  // 「网林定制淘宝」，15:43 与 16:01（测试版）两版都改成了「网林家居」；同一天新日报 base
  // 「各店铺日报 副本」的「店铺底单」与「各店铺数据日报」的「店铺」选项也都已经是「网林家居」。
  // 这个键**就是写进飞书「店铺」列的值**，所以它必须等于飞书侧的选项名 —— 否则第 13 家
  // 会在写入侧被 fail-closed（选项不存在）挡下，而其余 12 家照常成功。详见 shop-identities.mjs。
  网林家居: 'sales1',
  // 销售2部（5 家）
  保拉淘宝: 'sales2',
  保拉天猫: 'sales2',
  安比龙头店: 'sales2',
  科塔龙头店: 'sales2',
  安比淘宝: 'sales2',
});

/** 部门的可读名（报错与日志里用；键是内部值，别把它印给人看）。 */
export const DEPARTMENT_LABELS = Object.freeze({
  sales1: '销售1部',
  sales2: '销售2部',
});

/**
 * 月份 × 部门 → 商品数据 base 及它里面三张被写的表。
 *
 * 月份的口径 = **数据的统计日期**（也就是链上那个 `--date`），不是「跑的那天」。
 * 依据：整条链其余部分（底单行、幂等键、报表的「统计日期」列）都锚在 `--date` 上；
 * 若这里改用运行日期，跨月那天早上补跑前一天的数据就会写进新月份的 base，
 * 而同一批数据在旧 base 里已经有行 —— 出现「同一天的数据分裂在两个 base」。
 *
 * ⚠️ 这张表**不走客户配置层**：`runtime/customer-config.mjs` 的 overlay 只作用在
 * `PROFILES` 上的字段，这里是模块级常量。将来要交付给客户（base 完全不同）时，
 * 先决定是把它挪进配置层、还是让客户共用同一批 base ——
 * **别让客户去改这个文件**（那会把「配置」变成「改源码」，升级就会覆盖掉它）。
 */
export const PRODUCT_DATA_MONTH_BASES = Object.freeze({
  '2026-09:sales1': Object.freeze({
    baseToken: 'DQ2DbRinJaDx8Ss4gVFczsTXn3d',
    baseName: '9月商品监控表',
    productTable: 'tblzyf0oLvfbvN1l',
    inquiryTable: 'tbl1hHlRX0LYMvYY',
    promotionTable: 'tblaCPQMLWAq21Gw',
  }),
  '2026-10:sales1': Object.freeze({
    baseToken: 'FhCUbn7vVaEc26sRjMAccQJAn5e',
    baseName: '10月商品监控表-销售1部',
    productTable: 'tbley1xD9wDfQheX',
    inquiryTable: 'tblenEzSMpp5RTQb',
    promotionTable: 'tblC6QPcGOQu1D0T',
  }),
  '2026-10:sales2': Object.freeze({
    baseToken: 'ZYwWbYP9fa5d3rsXX8IcKrkYnod',
    baseName: '10月商品监控表-销售2部 副本',
    productTable: 'tbl1Y9pPDKigluLL',
    inquiryTable: 'tblux0yx7kUaYD3h',
    promotionTable: 'tbld7K4Fwy9ISh9R',
  }),
});

/** 按运营叫法取部门。**未登记一律抛错**（fail-closed），不回落成「猜一个部门」。 */
export function departmentOfShop(shopKey) {
  const department = SHOP_DEPARTMENTS[shopKey];
  if (!department) {
    throw new Error(`店铺「${shopKey}」没有登记部门；已登记：${Object.keys(SHOP_DEPARTMENTS).join(' / ')}`);
  }
  return department;
}

/**
 * 从数据日期里取飞书月份键（`YYYY-MM`）。
 * 接受 `YYYY-MM-DD` 与 `YYYY-MM`；别的形状（空、闰日之外的怪字符串、数字时间戳）一律抛错 ——
 * 这里放行一个「看起来差不多」的值，下游就会拿着它去查一个不存在的 base，
 * 报出来的错却是「没有这个月的 base」，把「日期传错了」伪装成「base 没建」。
 */
export function feishuMonthOf(dateInput) {
  const match = String(dateInput ?? '').match(/^(\d{4})-(\d{2})(?:-\d{2})?$/u);
  if (!match) {
    throw new Error(`飞书月份只认 YYYY-MM 或 YYYY-MM-DD，收到 ${JSON.stringify(dateInput)}`);
  }
  const month = Number(match[2]);
  if (month < 1 || month > 12) throw new Error(`月份超出 1-12：${JSON.stringify(dateInput)}`);
  return `${match[1]}-${match[2]}`;
}

/** `YYYY-MM:部门` 这个注册表键（调用方要打日志/写收据时用同一处拼，别各拼一份）。 */
export function productDataBaseKey(shopKey, dateInput) {
  return `${feishuMonthOf(dateInput)}:${departmentOfShop(shopKey)}`;
}

/**
 * **商品数据链唯一的取目标入口**：按「这家店 + 这天数据」解析出该写哪张 base、哪几张表。
 *
 * 缺登记一律抛错，并把「已登记了哪些月份×部门」原样列出来 ——
 * 新月份上线时最常见的一步就是漏建/漏登记一张 base，报错里带上全表，
 * 下一个人才不用靠猜「到底是没建还是名字写错了」。
 */
export function productDataTargetsForShop(shopKey, dateInput, name) {
  const department = departmentOfShop(shopKey);
  const key = productDataBaseKey(shopKey, dateInput);
  const target = PRODUCT_DATA_MONTH_BASES[key];
  if (!target) {
    throw new Error(`没有「${key.split(':')[0]}」×「${DEPARTMENT_LABELS[department] ?? department}」的商品数据 base`
      + `（店铺「${shopKey}」→ ${department}，profile=${resolveProfileName(name)}）；`
      + `已登记：${Object.keys(PRODUCT_DATA_MONTH_BASES).join(' / ')}`
      + ' —— 新月份要先在飞书建好 base、再把它的 baseToken 与表 id 登记进 PRODUCT_DATA_MONTH_BASES；'
      + '不许回落到上个月的 base（那样会「跑成功但写进运营不看的表」）');
  }
  return target;
}

/**
 * 注册表自洽性体检（**不依赖当前时间**，所以可以放进单测）。
 *
 * 守两件事：
 *   ① 每个键都是 `YYYY-MM:已登记的部门`，每个条目的 token / 表 id 形状合法；
 *   ② **最新那个月必须覆盖全部在用的部门** —— 上月加了 2 部、这月忘了加，
 *      结果是 2 部那 5 家整天写不进去，而别的店照常成功（一半绿一半红最难看出来）。
 *
 * 为什么不在这里也读一遍飞书核对 base 存在：那需要凭据与网络，会把单测变成联网测试。
 * 核对归属靠 `feishu-targets.test.mjs` 的交叉断言（与 SHOP_BROWSERS 同序同键）。
 */
export function assertProductDataBaseCoverage({
  registry = PRODUCT_DATA_MONTH_BASES,
  departments = SHOP_DEPARTMENTS,
} = {}) {
  const problems = [];
  const known = new Set(Object.values(departments));
  const byMonth = new Map();
  const tokenOwners = new Map();
  for (const [key, entry] of Object.entries(registry)) {
    const match = key.match(/^(\d{4}-\d{2}):([a-z0-9]+)$/u);
    if (!match) {
      problems.push(`键「${key}」不是「YYYY-MM:部门」形状`);
      continue;
    }
    const [, month, department] = match;
    if (!known.has(department)) {
      problems.push(`键「${key}」的部门「${department}」没有任何店铺归属（已知：${[...known].join(' / ')}）`);
    }
    if (!byMonth.has(month)) byMonth.set(month, new Set());
    byMonth.get(month).add(department);
    for (const field of ['baseToken', 'baseName', 'productTable', 'inquiryTable']) {
      if (!entry?.[field]) problems.push(`「${key}」缺 ${field}`);
    }
    for (const [field, pattern] of [['baseToken', /^[A-Za-z0-9]{20,}$/u], ['productTable', /^tbl[A-Za-z0-9]{10,}$/u],
      ['inquiryTable', /^tbl[A-Za-z0-9]{10,}$/u], ['promotionTable', /^tbl[A-Za-z0-9]{10,}$/u]]) {
      const value = entry?.[field];
      if (value === undefined) continue;
      if (!pattern.test(value)) problems.push(`「${key}」的 ${field}=${JSON.stringify(value)} 形状非法`);
    }
    // 同一个 base 登记在两个键下必然有一处是抄错的（各部门是分开的 base）。
    const owner = tokenOwners.get(entry?.baseToken);
    if (owner) problems.push(`baseToken ${entry?.baseToken} 同时登记在「${owner}」与「${key}」下`);
    else if (entry?.baseToken) tokenOwners.set(entry.baseToken, key);
  }
  const months = [...byMonth.keys()].sort();
  const latest = months.at(-1) ?? null;
  if (latest !== null) {
    for (const department of known) {
      if (byMonth.get(latest).has(department)) continue;
      const shops = Object.keys(departments).filter((shop) => departments[shop] === department);
      problems.push(`最新月份「${latest}」缺部门「${DEPARTMENT_LABELS[department] ?? department}」`
        + `（这 ${shops.length} 家会整天写不进去：${shops.join(' / ')}）`);
    }
  }
  if (problems.length > 0) {
    throw new Error(`商品数据 base 注册表不自洽：\n- ${problems.join('\n- ')}`);
  }
  return { months, latest, departments: [...known].sort() };
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
