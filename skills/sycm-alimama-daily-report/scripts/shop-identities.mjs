// 店铺身份登记表（唯一来源）——「运营叫法 ↔ 生意参谋页头店名 ↔ 阿里妈妈会员名/ID」。
//
// 为什么必须有这份东西（三条都是实测出来的缺口，见
// docs/ops/MULTI-SHOP-AND-INTERACTION-DECISION.md §5.3.2）：
//
//   1. 同一家店在四个地方有四个名字，而且**本来就可以不同名**：
//        阿里妈妈页头   = 登录会员名 + 会员数字 ID（这一页从不显示店铺名）
//        生意参谋页头   = 店铺名 + 主店/子店
//        导出工作簿     = 「店铺名称」列
//        飞书「店铺」列 = 运营自己的叫法（带平台后缀，如 盖文淘宝）
//      ⇒ 「跨站点比名字」没有意义，必须**逐站点各取各的、各自比对**。
//      实测例：盖文淘宝那家，阿里妈妈显示 `随心品质定制:阿彦`、生意参谋显示 `盖文全卫定制`
//      —— 两个都不是「盖文淘宝」。所以这份表不能靠名字相似度推，只能照抄。
//
//   2. 两个采集脚本原先**一次身份都没核对过**；而两个产物里只有一个带身份：
//      生意参谋 xlsx 有「店铺名称」列，**阿里妈妈营销场景报表 CSV 69 列里一个店铺身份字段都没有**。
//      ⇒ 取错窗口时，推广这一步是**静默**的：文件照落、数字照进飞书，事后从产物里查不出来。
//      2026-09-18 补上了两道判据（`collect-core.mjs` 的 assertShopIdentity / assertMemberIdentity），
//      本文件就是给它们提供**期望值**的地方。
//
//   3. 期望值原先要靠人手敲。敲错一个字，判据就会在**正确的窗口上拦人**（更糟的是：
//      敲成别家店的名字，于是在**错误的窗口上放行**）。所以期望值必须来自一处可核的来源。
//
// 数据来源（可核）：用户 2026-09-18 给的「完整表」——飞书 base「各店铺日报」里的「店铺底单」，
// 12 行，两列：`平台店铺全称` / `店铺`。只读读回（脚本见下），逐字照抄在 RAW_MAPPING_ROWS。
// 用户原话：「这个是完整表…这是一一对应的」。
//
// 已实测的部分（右侧 `sycmHeaderVerified` / `alimamaVerified`）在 2026-09-18 用真实页面读到，
// 判据表达式就是 collect-core.mjs 里那两个（不在探针里另写一份，避免「验的是另一套」）。
// **未实测的字段一律是 null，不填推测值** —— 宁可让调用方 fail-closed，也不要一个猜出来的身份。
//
// 只读核对脚本（仓库外，避免被仓库守卫扫到）：D:/Retire/probe-20260918/
//   read-mapping-table.mjs   —— 把「店铺底单」原文读下来
//   probe-identity-live.mjs  —— 用它把四个窗口的真实身份读出来（直接 import 本技能源码）
//   compare-bases.diff  系列  —— 两个同名 base 的对照（见 docs §5.3.3）

/**
 * 映射表的出处。刻意带 base/table/view 三个 id 与读取日期：
 * 以后有人质疑某个名字，要能一键回到那张表上重读，而不是翻聊天记录。
 */
export const MAPPING_SOURCE = Object.freeze({
  baseToken: 'PTfHbPt9EaIzddsfL8Jcj238nrb',
  baseName: '各店铺日报',
  tableId: 'tblbjgtZL88a6xHY',
  tableName: '店铺底单',
  viewId: 'vewHFEZub9',
  readAt: '2026-09-18',
  recordCount: 12,
});

/**
 * 逐字照抄的 12 行原文（顺序＝表里的行序）。
 * 这一份是「证据」，不是「配置」：SHOP_IDENTITIES 由它派生，测试断言两者的对应关系忠实。
 * 左列 `平台店铺全称`（＝生意参谋页头店名），右列 `店铺`（＝飞书「各店铺数据日报」的选项名／运营叫法）。
 */
export const RAW_MAPPING_ROWS = Object.freeze([
  Object.freeze(['科塔全卫定制', '科塔淘宝']),
  Object.freeze(['盖文全卫定制', '盖文淘宝']),
  Object.freeze(['盖文旗舰店', '盖文天猫']),
  Object.freeze(['Paola Lenti保拉伦蒂', '保拉淘宝']),
  Object.freeze(['保拉伦蒂旗舰店', '保拉天猫']),
  Object.freeze(['网林全卫定制', '网林淘宝']),
  Object.freeze(['网林家居旗舰店', '网林天猫']),
  Object.freeze(['里可林家居', '里可林淘宝']),
  Object.freeze(['里可林旗舰店', '里可林天猫']),
  Object.freeze(['安比全卫定制', '安比龙头店']),
  Object.freeze(['科塔建材卫浴', '科塔龙头店']),
  Object.freeze(['安比定制家居', '安比淘宝']),
]);

// 平台从运营叫法的后缀推。写成一个映射而不是正则拼接，是为了让「出现了新后缀」当场炸，
// 而不是被某个宽松的正则静默吞掉（坑 36：静默落空）。
const PLATFORM_BY_SUFFIX = Object.freeze({
  淘宝: 'taobao',
  天猫: 'tmall',
  龙头店: 'leading',
});

export function platformOf(shopKey) {
  for (const [suffix, platform] of Object.entries(PLATFORM_BY_SUFFIX)) {
    if (shopKey.endsWith(suffix)) return platform;
  }
  throw new Error(`店铺叫法「${shopKey}」没有已知的平台后缀（已知：${Object.keys(PLATFORM_BY_SUFFIX).join(' / ')}）`);
}

/**
 * 12 家店的身份。字段含义：
 *   key                 运营叫法（＝回填时写进「店铺」列的值，也是幂等键的一半）
 *   fullName            平台店铺全称（＝生意参谋页头店名）
 *   platform            taobao | tmall | leading（由 key 后缀派生，测试会核对一致）
 *   sycmHeader          生意参谋页头店名；**已实测的行与 fullName 相同**（这正是「按页头店名能唯一认店」的判据）
 *   sycmHeaderVerified  'expression' 用本技能那两个表达式读到 | 'text' 只从页面正文读到 | null 未实测
 *   alimamaMemberName   阿里妈妈页头的登录会员名（**可能与店名毫无关系**）
 *   alimamaMemberId     阿里妈妈页头的会员数字 ID
 *   alimamaVerified     'expression' | 'human-record' | null
 *   isolatedProfile     见文件末尾的 ISOLATED_PROFILES（单独一张表，不塞进每一行）：
 *                       端口不在本文件里 —— 端口只有一个来源 runtime/browser-ports.mjs，
 *                       而且「按店铺实例化」还没做（见 docs §4.2）
 *   evidence            这一行的证据出处（哪一天、在哪个窗口/哪份文档）
 *
 * 为什么 alimamaMemberName 与 key 分开存而不是派生成 `${key}:阿彦`：
 * 实测已推翻这个假设（盖文淘宝那家的会员名是 `随心品质定制:阿彦`）。
 * 派生值一旦写进判据，就会变成「在正确窗口上拦人」的假警报。
 */
export const SHOP_IDENTITIES = Object.freeze([
  Object.freeze({
    key: '科塔淘宝',
    fullName: '科塔全卫定制',
    platform: 'taobao',
    sycmHeader: '科塔全卫定制',
    sycmHeaderVerified: 'expression',
    alimamaMemberName: 'j873522735:阿彦',
    alimamaMemberId: '412070158',
    alimamaVerified: 'expression',
    evidence: '2026-09-18 实测：隔离 profile shop-j873522735 的窗口，两个表达式各读一次',
  }),
  Object.freeze({
    key: '盖文淘宝',
    fullName: '盖文全卫定制',
    platform: 'taobao',
    sycmHeader: '盖文全卫定制',
    sycmHeaderVerified: 'expression',
    alimamaMemberName: '随心品质定制:阿彦',
    alimamaMemberId: '887360146',
    alimamaVerified: 'expression',
    evidence: '2026-09-18 实测：隔离 profile suixin-custom 的窗口。会员名与店名不同名（老会员号沿用旧品牌名）',
  }),
  Object.freeze({
    key: '盖文天猫',
    fullName: '盖文旗舰店',
    platform: 'tmall',
    sycmHeader: '盖文旗舰店',
    // 只在页面正文里读到「生意参谋 盖文旗舰店 主店 惠商 …」，没走那两个表达式 ⇒ 如实降级
    sycmHeaderVerified: 'text',
    alimamaMemberName: '盖文旗舰店:阿彦',
    alimamaMemberId: '2995200080',
    // 生产那个窗口当时连不上（探针 fetch failed），这个 ID 是人工从页面上抄下来的 ⇒ 如实标
    alimamaVerified: 'human-record',
    evidence: '2026-09-17 生意参谋页头正文（独立探针）；会员 ID 记于 docs/ops/MULTI-SHOP-AND-INTERACTION-DECISION.md §5.3.2',
  }),
  Object.freeze({
    key: '保拉淘宝',
    fullName: 'Paola Lenti保拉伦蒂',
    platform: 'taobao',
    sycmHeader: null,
    sycmHeaderVerified: null,
    alimamaMemberName: null,
    alimamaMemberId: null,
    alimamaVerified: null,
    evidence: '未实测：没有该店的隔离窗口',
  }),
  Object.freeze({
    key: '保拉天猫',
    fullName: '保拉伦蒂旗舰店',
    platform: 'tmall',
    sycmHeader: null,
    sycmHeaderVerified: null,
    alimamaMemberName: null,
    alimamaMemberId: null,
    alimamaVerified: null,
    evidence: '未实测：没有该店的隔离窗口',
  }),
  Object.freeze({
    key: '网林淘宝',
    fullName: '网林全卫定制',
    platform: 'taobao',
    sycmHeader: null,
    sycmHeaderVerified: null,
    alimamaMemberName: null,
    alimamaMemberId: null,
    alimamaVerified: null,
    evidence: '未实测：没有该店的隔离窗口',
  }),
  Object.freeze({
    key: '网林天猫',
    fullName: '网林家居旗舰店',
    platform: 'tmall',
    sycmHeader: '网林家居旗舰店',
    sycmHeaderVerified: 'expression',
    alimamaMemberName: '网林家居旗舰店:阿彦',
    alimamaMemberId: '7314426323',
    alimamaVerified: 'expression',
    evidence: '2026-09-18 实测：隔离 profile wanglin-flagship 的窗口',
  }),
  Object.freeze({
    key: '里可林淘宝',
    fullName: '里可林家居',
    platform: 'taobao',
    sycmHeader: '里可林家居',
    sycmHeaderVerified: 'expression',
    alimamaMemberName: '里可林家居:阿彦',
    alimamaMemberId: '2350600069',
    alimamaVerified: 'expression',
    evidence: '2026-09-18 实测：隔离 profile likelin-home 的窗口',
  }),
  Object.freeze({
    key: '里可林天猫',
    fullName: '里可林旗舰店',
    platform: 'tmall',
    sycmHeader: null,
    sycmHeaderVerified: null,
    alimamaMemberName: null,
    alimamaMemberId: null,
    alimamaVerified: null,
    evidence: '未实测：没有该店的隔离窗口',
  }),
  Object.freeze({
    key: '安比龙头店',
    fullName: '安比全卫定制',
    platform: 'leading',
    sycmHeader: null,
    sycmHeaderVerified: null,
    alimamaMemberName: null,
    alimamaMemberId: null,
    alimamaVerified: null,
    evidence: '未实测：没有该店的隔离窗口',
  }),
  Object.freeze({
    key: '科塔龙头店',
    fullName: '科塔建材卫浴',
    platform: 'leading',
    sycmHeader: null,
    sycmHeaderVerified: null,
    alimamaMemberName: null,
    alimamaMemberId: null,
    alimamaVerified: null,
    evidence: '未实测：没有该店的隔离窗口',
  }),
  Object.freeze({
    key: '安比淘宝',
    fullName: '安比定制家居',
    platform: 'taobao',
    sycmHeader: null,
    sycmHeaderVerified: null,
    alimamaMemberName: null,
    alimamaMemberId: null,
    alimamaVerified: null,
    evidence: '未实测：没有该店的隔离窗口',
  }),
]);

export function shopKeys() {
  return SHOP_IDENTITIES.map((row) => row.key);
}

/**
 * 「哪家店在哪个专用 profile 里被实测过」—— 2026-09-18 建立的四个店铺专用 profile
 * （`D:/Retire/edge-profiles/<名>`，首次启动带 `--disable-sync`、`Login Data` 0 条，见 docs §5.3.1）；
 * **2026-09-19 补上第五家「盖文天猫」**（`gaiwen-flagship`，端口 19035/19045）——
 * 用户当日口径：盖文旗舰店与盖文全卫定制是两家店，全卫＝盖文淘宝，旗舰店＝盖文天猫，
 * 「没有专用浏览器就新增一个」。它与 `runtime/browser-ports.mjs` 的 `SHOP_BROWSERS` 逐键互核
 * （见 `runtime/browser-ports.test.mjs`），两边漂移会当场红。
 *
 * 为什么要单独一张表：这张表的键是**被实测过**的证据指针，不是配置。
 * 它现在的用途有两个：① 说明登记表里那 5 行实测值是从哪来的；② 让「两个店铺共用一个 profile」
 * 这种复制粘贴事故当场变红（键唯一、且键必须是已登记店铺）。
 */
export const ISOLATED_PROFILES = Object.freeze({
  里可林淘宝: 'likelin-home',
  网林天猫: 'wanglin-flagship',
  盖文淘宝: 'suixin-custom',
  盖文天猫: 'gaiwen-flagship',
  科塔淘宝: 'shop-j873522735',
});

/** 按运营叫法取登记行。**未登记一律抛错**（fail-closed），不回落成「不核对」。 */
export function shopIdentity(key) {
  const found = SHOP_IDENTITIES.find((row) => row.key === key);
  if (!found) {
    throw new Error(`未登记的店铺「${key}」；已登记：${shopKeys().join(' / ')}`);
  }
  return found;
}

/** 按生意参谋页头店名取登记行。fullName 在表里唯一，所以这里能当面验「唯一匹配」。 */
export function shopIdentityByHeader(header) {
  const matches = SHOP_IDENTITIES.filter((row) => row.fullName === header);
  if (matches.length === 0) {
    throw new Error(`没有哪家店的平台店铺全称是「${header}」`);
  }
  if (matches.length > 1) {
    throw new Error(`「${header}」在登记表里对应 ${matches.length} 家店：${matches.map((r) => r.key).join(' / ')}`);
  }
  return matches[0];
}

/**
 * 组装采集脚本的身份期望值（`--expect-shop` / `--expect-member` / `--expect-member-id`）。
 *
 * `require` 是**必填的字段名列表**（'shop' | 'member'），登记表里缺这个字段就直接抛错：
 * 目的不是"方便"，而是堵住一条静默通道 —— 如果缺字段时只是少给一个参数，
 * 采集就会在**没有该判据**的情况下跑完，而调用方以为自己开着守卫（坑 38：
 * 能力删在生产者侧，故障显在消费者侧）。
 *
 * 不传 require 时按「知道多少给多少」组装：能给的给，给不了的留空，
 * 并在 `missing` 里如实列出 —— 交给调用方决定这是否可接受。
 */
export function expectArgs(key, { require = [] } = {}) {
  const row = shopIdentity(key);
  const unknown = [];
  if (!row.sycmHeader) unknown.push('shop');
  if (!row.alimamaMemberName || !row.alimamaMemberId) unknown.push('member');

  const missing = require.filter((field) => unknown.includes(field));
  if (missing.length > 0) {
    const detail = missing.map((field) => (field === 'shop'
      ? `生意参谋页头店名（sycmHeader）`
      : `阿里妈妈会员名/ID（alimamaMemberName/alimamaMemberId）`)).join('；');
    throw new Error(`店铺「${key}」的 ${detail} 还没有实测值（${row.evidence}）`
      + `—— 不能拿一个猜出来的身份去开守卫；先实测再跑`);
  }

  const args = [];
  if (row.sycmHeader) args.push('--expect-shop', row.sycmHeader);
  if (row.alimamaMemberName) args.push('--expect-member', row.alimamaMemberName);
  if (row.alimamaMemberId) args.push('--expect-member-id', row.alimamaMemberId);
  return { args, missing: unknown };
}

/**
 * 「证据目录的店铺键（＝运营叫法）对得上源产物吗」。
 *
 * 为什么要有这条判据（2026-09-18 一轮多店铺实测）：一旦目录名里带店铺维度，
 * **贴错标签比不贴标签更糟** —— 一个叫 `daily-report-2026-09-17-网林天猫` 的目录里装着里可林的数据，
 * 下一个复盘的人会拿着它得出完全错误的结论，而且从文件名上看不出来。
 *
 * 所以：键必须是**已登记**的运营叫法（未登记一律抛错，不回落成「不核对」），
 * 并且凡是调用方能观察到的店名都要与登记表对上。`observed` 里给什么就核什么，
 * 不给就不核 —— 三个写入方能观察到的面不一样（见各自调用处）。
 *
 *   源产物（xlsx 的「店铺名称」列） → 与 fullName 比
 *   回填的 `--shop`（飞书选项名）   → 与 key 比
 */
export function assertEvidenceShopKey(key, observed = {}) {
  const row = shopIdentity(key);
  const mismatches = [];
  if (observed.fullName !== undefined && observed.fullName !== row.fullName) {
    mismatches.push(`源产物里的店名 ${JSON.stringify(observed.fullName)}`
      + ` ≠ 登记的平台店铺全称 ${JSON.stringify(row.fullName)}`);
  }
  if (observed.shopKey !== undefined && observed.shopKey !== row.key) {
    mismatches.push(`同一命令里另一处给的店铺叫法 ${JSON.stringify(observed.shopKey)} ≠ ${JSON.stringify(row.key)}`);
  }
  if (mismatches.length > 0) {
    throw new Error(`证据目录的店铺键 ${JSON.stringify(key)} 对不上：${mismatches.join('；')}`
      + ' —— 这会把一个错标签贴在目录上（比不贴标签更糟），停手');
  }
  return row;
}

/** 人看的一行摘要（写日志/文档时用，避免各处自己拼措辞）。 */
export function describeIdentity(key) {
  const row = shopIdentity(key);
  const mark = (value, verified) => (value ? `${value}${verified ? '' : '（未实测）'}` : '（未实测）');
  return `${row.key} | 页头店名 ${mark(row.sycmHeader, row.sycmHeaderVerified)}`
    + ` | 会员 ${mark(row.alimamaMemberName, row.alimamaVerified)}`
    + ` ${mark(row.alimamaMemberId, row.alimamaVerified)}`;
}

/**
 * 把参数数组格式化成一行可粘贴的命令（只有这一处决定引号规则）。
 *
 * 为什么要带引号规则：`保拉淘宝` 的平台店铺全称是 `Paola Lenti保拉伦蒂`（**带空格**），
 * 直接粘到命令行会被拆成两个参数，而脚本收到的 `--expect-shop Paola` 会读不到店名
 * ⇒ 判据变成「读不到身份，拒绝继续」（这次是**安全**的失败方向，但会让人误以为页面坏了）。
 * 会员名里的 `:`（`j873522735:阿彦`）不算需要引号的字符，不额外加 —— 加错了在 PowerShell 里更麻烦。
 */
export function formatArgv(args) {
  return args.map((value) => (/[\s"]/u.test(String(value)) ? `"${value}"` : String(value))).join(' ');
}
