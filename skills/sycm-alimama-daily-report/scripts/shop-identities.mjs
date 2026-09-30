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
//      实测例：盖文淘宝那家，阿里妈妈显示 `随心品质定制:阿彦`（2026-09-30 起子账号改为 `:小瓜`）、生意参谋显示 `盖文全卫定制`
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
// 数据来源有**两个**，别混成一个（2026-09-30 起）：
//
//   ① 店铺维度（`key` ↔ `fullName`）——来自飞书 base「各店铺日报」的「店铺底单」，
//      2026-09-18 只读读回，**12 行**，两列：`平台店铺全称` / `店铺`。逐字照抄在 RAW_MAPPING_ROWS。
//      用户原话：「这个是完整表…这是一一对应的」。
//   ② 第 13 家「网林定制淘宝」**不在这 12 行里** —— 它是 2026-09-30 新增的店，
//      飞书底单当天还没这一行。它的 key/fullName 来自用户同日给的《店铺账号信息表》，
//      单列在 EXTRA_SHOPS_FROM_ACCOUNT_TABLE（不许混进 RAW_MAPPING_ROWS：那份是「读回的原文」，
//      往里补一行就等于伪造证据）。
//
// 操作员账号（`alimamaMemberName`）：2026-09-30 起以用户《店铺账号信息表》为准，
// 13 家全部换成表里给定的操作员（用户口径：「操作员固定好，以后一般不会再更改了」）。
// 当天下午 13 家逐店人工登录一次，**13 家的会员名/ID 与页头店名都升到了 `expression` 级**
// （用采集脚本那两个表达式在真实窗口里读到，与账号表逐字一致）—— 所以
// IDENTITY_MEMBER_MEASURED_SHOPS / IDENTITY_SHOP_HEADER_VERIFIED_SHOPS 现在都是 13 家。
// 原 5 家的 `:阿彦` 是被替换掉的旧值，已作废。
//
// ⚠️ **页头店名可能被平台截断**（2026-09-30 实测）：保拉淘宝的页头文本本身就是
// `Paola Lenti保拉伦...`（省略号在文本节点里，DOM 里没有 title/aria-label 可取全名），
// 而它的平台店铺全称（店铺底单原文）是 `Paola Lenti保拉伦蒂`。
// ⇒ `sycmHeader` 必须写**实测到的截断值**（闸门用同一个表达式，写全称会在正确窗口上拦人），
// `fullName` 保持底单原文不动。这是唯一允许两者不同名的情形，测试里显式记账。
//
// 已实测的部分（右侧 `sycmHeaderVerified`）在 2026-09-18 用真实页面读到，
// 判据表达式就是 collect-core.mjs 里那两个（不在探针里另写一份，避免「验的是另一套」）。
// **未实测的字段一律是 null，不填推测值** —— 宁可让调用方 fail-closed，也不要一个猜出来的身份。
//
// 只读核对脚本（仓库外，避免被仓库守卫扫到）：
//   D:/Retire/probe-20260918/  read-mapping-table.mjs（把「店铺底单」原文读下来）
//                              probe-identity-live.mjs（把窗口的真实身份读出来）
//   D:/Retire/probe-20260930/  read-base-meta.mjs 等（10 月新 base 的只读取证）

/**
 * 映射表的出处。刻意带 base/table/view 三个 id 与读取日期：
 * 以后有人质疑某个名字，要能一键回到那张表上重读，而不是翻聊天记录。
 *
 * ⚠️ `recordCount` 是**那张表当时的行数**（12），不是登记表现在的行数（13）。
 * 两者必须分开看：差的那 1 家就是 EXTRA_SHOPS_FROM_ACCOUNT_TABLE。
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
 * 操作员账号表的出处（第二来源）。给的是「哪家店归谁登」，不是窗口里读到的身份。
 *
 * 为什么不并进 MAPPING_SOURCE：那是「店铺底单」的出处，两份东西的字段、行数、
 * 可信度都不同；并在一起就再也说不清「这一格是从哪来的」。
 */
export const ACCOUNT_TABLE_SOURCE = Object.freeze({
  fileName: '店铺账号信息表(1)(1).xlsx',
  receivedAt: '2026-09-30',
  receivedVia: '微信（用户发来的最新一版；前两版因部门/base 列不全被替换）',
  operatorFixedAt: '2026-09-30',
  note: '用户口径：操作员固定、以后不再更改。账号列的值＝阿里妈妈页头的登录会员名（形如「主账号:子账号」）。',
});

/**
 * 只在操作员账号表里有、飞书「店铺底单」还没有行的店铺。
 * 目前 1 家。它必须显式列出来 —— 否则「登记表 13 行 vs 底单 12 行」这个差
 * 会被下一个读代码的人当成抄袭事故。
 */
export const EXTRA_SHOPS_FROM_ACCOUNT_TABLE = Object.freeze(['网林定制淘宝']);

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
 * 13 家店的身份（销售1部 8 家 + 销售2部 5 家）。字段含义：
 *   key                 运营叫法（＝回填时写进「店铺」列的值，也是幂等键的一半）
 *   fullName            平台店铺全称（＝生意参谋页头店名）
 *   platform            taobao | tmall | leading（由 key 后缀派生，测试会核对一致）
 *   sycmHeader          生意参谋页头店名；**已实测的行与 fullName 相同**（这正是「按页头店名能唯一认店」的判据）
 *   sycmHeaderVerified  'expression' 用本技能那两个表达式读到 | 'text' 只从页面正文读到 | null 未实测
 *   alimamaMemberName   阿里妈妈页头的登录会员名（**可能与店名毫无关系**）。
 *                       **2026-09-30 起全部来自用户《店铺账号信息表》给定的操作员** ⇒ human-record。
 *   alimamaMemberId     阿里妈妈页头的会员数字 ID。**它是主账号的属性，不随操作员变**，
 *                       所以换人之后那 5 家的原实测值仍然有效；另外 8 家（+第 13 家）表里没给，是 null。
 *                       ⚠️ 允许「有名字没 ID」：判据 `assertMemberIdentity` 只给 name 时照样是有效闸门，
 *                       只是少一道旁证。所以「成对出现」不是硬约束 —— 硬约束是「不许有 ID 没名字」。
 *   alimamaVerified     'expression'（窗口实测）| 'human-record'（人工记录，可当期望值但不算实测）| null
 *   isolatedProfile     见文件末尾的 ISOLATED_PROFILES（单独一张表，不塞进每一行）：
 *                       端口不在本文件里 —— 端口只有一个来源 runtime/browser-ports.mjs
 *   evidence            这一行的证据出处（哪一天、在哪个窗口/哪份文档）
 *
 * 为什么 alimamaMemberName 与 key 分开存而不是派生成「店名 + 冒号 + 子账号」：
 * 实测已推翻这个假设（盖文淘宝那家的会员名前缀是 `随心品质定制`，不是店名 `盖文淘宝`）。
 * 2026-09-30 换操作员又加固了一次：子账号一变，任何派生值当场失效。
 * 派生值一旦写进判据，就会变成「在正确窗口上拦人」的假警报。
 */
export const SHOP_IDENTITIES = Object.freeze([
  Object.freeze({
    key: '科塔淘宝',
    fullName: '科塔全卫定制',
    platform: 'taobao',
    sycmHeader: '科塔全卫定制',
    sycmHeaderVerified: 'expression',
    alimamaMemberName: 'j873522735:嘉慧',
    alimamaMemberId: '412070158',
    alimamaVerified: 'expression',
    evidence: '页头店名 2026-09-18 实测、2026-09-30 复核一致（隔离 profile shop-j873522735）。会员名与会员 ID 2026-09-30 用采集表达式实测（换操作员后的值）；此前人工记录的 :阿彦 已作废',
  }),
  Object.freeze({
    key: '盖文淘宝',
    fullName: '盖文全卫定制',
    platform: 'taobao',
    sycmHeader: '盖文全卫定制',
    sycmHeaderVerified: 'expression',
    alimamaMemberName: '随心品质定制:小瓜',
    alimamaMemberId: '887360146',
    alimamaVerified: 'expression',
    evidence: '页头店名 2026-09-18 实测、2026-09-30 复核一致（隔离 profile suixin-custom）。会员名与会员 ID 2026-09-30 用采集表达式实测。**会员名与店名不同名是正常的**（老会员号沿用旧品牌名）',
  }),
  Object.freeze({
    key: '盖文天猫',
    fullName: '盖文旗舰店',
    platform: 'tmall',
    sycmHeader: '盖文旗舰店',
    sycmHeaderVerified: 'expression',
    alimamaMemberName: '盖文旗舰店:小瓜',
    alimamaMemberId: '2995200080',
    alimamaVerified: 'expression',
    evidence: '页头店名 2026-09-19 实测、2026-09-30 复核一致（隔离 profile gaiwen-flagship）。会员名与会员 ID 2026-09-30 用采集表达式实测（替换 2026-09-17 人工抄录、09-19 实测的 :阿彦）',
  }),
  Object.freeze({
    key: '保拉淘宝',
    fullName: 'Paola Lenti保拉伦蒂',
    platform: 'taobao',
    sycmHeader: 'Paola Lenti保拉伦...',
    sycmHeaderVerified: 'expression',
    alimamaMemberName: '保拉伦蒂:小保',
    alimamaMemberId: '1991150160',
    alimamaVerified: 'expression',
    evidence: '页头店名 2026-09-30 用采集表达式实测（隔离 profile paola-taobao）。⚠️ **平台把长店名截断了**：页头文本本身就是 `Paola Lenti保拉伦...`（省略号在文本节点里，`offsetWidth === scrollWidth`、DOM 无 title/aria-label 可取全名），而平台店铺全称（店铺底单原文）是 `Paola Lenti保拉伦蒂` ⇒ 这里的 sycmHeader 必须是**实测到的截断值**，否则闸门会在正确的窗口上拦人。会员名与会员 ID 同日用采集表达式实测',
  }),
  Object.freeze({
    key: '保拉天猫',
    fullName: '保拉伦蒂旗舰店',
    platform: 'tmall',
    sycmHeader: '保拉伦蒂旗舰店',
    sycmHeaderVerified: 'expression',
    alimamaMemberName: '保拉伦蒂旗舰店:小杜',
    alimamaMemberId: '7445214812',
    alimamaVerified: 'expression',
    evidence: '页头店名、会员名、会员 ID 均于 2026-09-30 用采集表达式实测（隔离 profile paola-tmall，当天人工登录一次）',
  }),
  Object.freeze({
    key: '网林淘宝',
    fullName: '网林全卫定制',
    platform: 'taobao',
    sycmHeader: '网林全卫定制',
    sycmHeaderVerified: 'expression',
    alimamaMemberName: '网林卫浴:小慧',
    alimamaMemberId: '1510910194',
    alimamaVerified: 'expression',
    evidence: '页头店名、会员名、会员 ID 均于 2026-09-30 用采集表达式实测（隔离 profile wanglin-taobao，当天人工登录一次）',
  }),
  Object.freeze({
    key: '网林天猫',
    fullName: '网林家居旗舰店',
    platform: 'tmall',
    sycmHeader: '网林家居旗舰店',
    sycmHeaderVerified: 'expression',
    alimamaMemberName: '网林家居旗舰店:饺子',
    alimamaMemberId: '7314426323',
    alimamaVerified: 'expression',
    evidence: '页头店名 2026-09-18 实测、2026-09-30 复核一致（隔离 profile wanglin-flagship）。会员名与会员 ID 2026-09-30 用采集表达式实测（替换当日实测的 :阿彦；账号表原写的密码是错的，已更正）',
  }),
  Object.freeze({
    key: '里可林淘宝',
    fullName: '里可林家居',
    platform: 'taobao',
    sycmHeader: '里可林家居',
    sycmHeaderVerified: 'expression',
    alimamaMemberName: '里可林家居:小宁',
    alimamaMemberId: '2350600069',
    alimamaVerified: 'expression',
    evidence: '页头店名 2026-09-18 实测、2026-09-30 复核一致（隔离 profile likelin-home）。会员名与会员 ID 2026-09-30 用采集表达式实测（替换当日实测的 :阿彦）',
  }),
  Object.freeze({
    key: '里可林天猫',
    fullName: '里可林旗舰店',
    platform: 'tmall',
    sycmHeader: '里可林旗舰店',
    sycmHeaderVerified: 'expression',
    alimamaMemberName: '里可林旗舰店:月饼',
    alimamaMemberId: '7449643996',
    alimamaVerified: 'expression',
    evidence: '页头店名、会员名、会员 ID 均于 2026-09-30 用采集表达式实测（隔离 profile likelin-tmall，当天人工登录一次）',
  }),
  Object.freeze({
    key: '安比龙头店',
    fullName: '安比全卫定制',
    platform: 'leading',
    sycmHeader: '安比全卫定制',
    sycmHeaderVerified: 'expression',
    alimamaMemberName: 'tb720555516:泡芙',
    alimamaMemberId: '4611324807',
    alimamaVerified: 'expression',
    evidence: '页头店名、会员名、会员 ID 均于 2026-09-30 用采集表达式实测（隔离 profile anbi-leading）。账号表原写的密码是错的，已按用户口述更正为 pf115588',
  }),
  Object.freeze({
    key: '科塔龙头店',
    fullName: '科塔建材卫浴',
    platform: 'leading',
    sycmHeader: '科塔建材卫浴',
    sycmHeaderVerified: 'expression',
    alimamaMemberName: '科塔建材卫浴品牌店:小森',
    alimamaMemberId: '6438408891',
    alimamaVerified: 'expression',
    evidence: '页头店名、会员名、会员 ID 均于 2026-09-30 用采集表达式实测（隔离 profile keta-leading，当天人工登录一次）',
  }),
  Object.freeze({
    key: '安比淘宝',
    fullName: '安比定制家居',
    platform: 'taobao',
    sycmHeader: '安比定制家居',
    sycmHeaderVerified: 'expression',
    alimamaMemberName: '安比定制家居:小森',
    alimamaMemberId: '2979090045',
    alimamaVerified: 'expression',
    evidence: '页头店名、会员名、会员 ID 均于 2026-09-30 用采集表达式实测（隔离 profile anbi-taobao）。账号表原写的密码是错的，已按用户口述更正为 xs115588',
  }),
  Object.freeze({
    key: '网林定制淘宝',
    fullName: '网林定制家居',
    platform: 'taobao',
    sycmHeader: '网林定制家居',
    sycmHeaderVerified: 'expression',
    alimamaMemberName: '网林定制家居:嘉嘉',
    alimamaMemberId: '1731780198',
    alimamaVerified: 'expression',
    evidence: '2026-09-30 用户《店铺账号信息表》新增的第 13 家（平台店铺全称「网林定制家居」）。底座与登录都在当天完成，页头店名、会员名、会员 ID 均于当天用采集表达式实测（隔离 profile wanglin-custom）。它 10 月两张商品 base 的「店铺」选项里还不存在 —— 开始采集前要补上那两个选项',
  }),
]);

export function shopKeys() {
  return SHOP_IDENTITIES.map((row) => row.key);
}

/**
 * 「哪家店在哪个专用 profile 里被实测过」。
 *
 * **2026-09-30 扩到 13 家**（5 → 12 → 13）。这张表现在**只有一层**：
 * 13 家的页头店名、会员名、会员 ID 都已用采集表达式在真实窗口里读到（`expression` 级）。
 * 演进路径留着当参照：09-29 加 8 家底座（那时页头店名还是 null）；09-30 上午换操作员把
 * 会员名那一侧**打回 human-record**，当天下午按 5/5/3 三批「起批 → 人工登录 → 只读探针读数 →
 * 释放」逐店实测，才全部升回 `expression`。两张显式清单跟着一起动（见下）。
 *
 * 这张表的键**必须与 `runtime/browser-ports.mjs` 的 `SHOP_BROWSERS` 逐键一致**
 * （见 `runtime/browser-ports.test.mjs`），两边漂移会当场红。
 *
 * ⚠️ 一条纪律没有变（它是这张表存在的理由）：**一店一 profile，绝不共用**。
 * 共用 profile ＝ 两个淘宝身份混在一个浏览器里，Chromium 会**自己挑一条凭据**，
 * 登错店不报任何错（2026-09-23 实测：商家浏览器那个 profile 里 `login.taobao.com`
 * 下有两条凭据，分属两家店）。
 */
export const ISOLATED_PROFILES = Object.freeze({
  // 销售1部（8 家）
  里可林淘宝: 'likelin-home',
  网林天猫: 'wanglin-flagship',
  盖文淘宝: 'suixin-custom',
  盖文天猫: 'gaiwen-flagship',
  科塔淘宝: 'shop-j873522735',
  网林淘宝: 'wanglin-taobao',
  里可林天猫: 'likelin-tmall',
  网林定制淘宝: 'wanglin-custom',
  // 销售2部（5 家）
  保拉淘宝: 'paola-taobao',
  保拉天猫: 'paola-tmall',
  安比龙头店: 'anbi-leading',
  科塔龙头店: 'keta-leading',
  安比淘宝: 'anbi-taobao',
});

/**
 * 页头店名已用采集表达式实测过的店铺（**显式清单，不是从字段推**）。
 *
 * 为什么要单独一行而不是「数 verified 非空的条数」：这条清单是**给人看的账**——
 * 新加一家店时它会当场红，逼着人要么去实测、要么把它写在这里当成一条能被复审的决定。
 * 推出来的话，「有一家掉级」和「本来就还没测」在测试里长得一模一样。
 */
export const IDENTITY_SHOP_HEADER_VERIFIED_SHOPS = Object.freeze([
  '科塔淘宝', '盖文淘宝', '盖文天猫', '保拉淘宝', '保拉天猫', '网林淘宝', '网林天猫',
  '里可林淘宝', '里可林天猫', '安比龙头店', '科塔龙头店', '安比淘宝', '网林定制淘宝',
]);

/**
 * 会员名已用采集表达式实测过的店铺。
 *
 * **2026-09-30 先归零、再填满**：当天上午换操作员（13 家全部退回 `human-record`），
 * 当天下午逐店人工登录后用只读探针跑采集表达式，读到的会员名/ID 与账号表**逐字一致**
 * ⇒ 13 家全部升回 `expression`。
 * 这个「归零 → 填满」的过程留着记：**换人会让实测值当场作废**，值换了级别必须跟着退回。
 */
export const IDENTITY_MEMBER_MEASURED_SHOPS = Object.freeze([
  '科塔淘宝', '盖文淘宝', '盖文天猫', '保拉淘宝', '保拉天猫', '网林淘宝', '网林天猫',
  '里可林淘宝', '里可林天猫', '安比龙头店', '科塔龙头店', '安比淘宝', '网林定制淘宝',
]);

/**
 * 还需要一次「人工登录 + 只读探针读数」的店铺 —— **当前为空**（13 家当天全部实测完）。
 *
 * 2026-09-30 的完整路径：上午换操作员 ⇒ 13 家全进这张清单；下午按 5/5/3 三批逐店登录并实测 ⇒ 清空。
 * 空清单是如实记账。**下次换操作员或新增店铺时这一栏必须重新填上** ——
 * 「已登记但还没测」的家一旦漏出这张清单，闸门就会拿一个没实测的身份去比。
 */
export const IDENTITY_PENDING_SHOPS = Object.freeze([]);


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
  // 「member 已知」的判据是**会员名**，不是「名字与 ID 都有」：
  // assertMemberIdentity 只给 name 时照样是有效闸门（ID 是旁证，不是前提）。
  // 写成「两个都要」的后果不是更保守，而是更松 —— 那 8 家只有名字的店会被判成
  // 「member 缺失」，闸门被白白关掉，而调用方还以为开着。
  if (!row.alimamaMemberName) unknown.push('member');

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

/**
 * 实测级别 → 摘要里要不要带标记。**只有 `expression` 不带**（＝真用采集脚本那两个表达式
 * 在真实窗口里读到的）。
 *
 * 为什么必须按级别判、不能按「值非空」判（2026-09-30 修）：换操作员之后 13 家的会员名
 * 全部是 `human-record`（人工填的）。原实现写的是 `verified ? '' : '（未实测）'` ——
 * `'human-record'` 是 truthy，于是摘要会把「人工填的」显示成「实测的」。
 * 这份表是判据的期望值来源，「看起来核过」与「其实没核」长得一样是最贵的一种糊弄。
 */
export const IDENTITY_VERIFIED_LABEL = Object.freeze({
  expression: null,
  'human-record': '人工记录，未实测',
  text: '仅页面正文，未实测',
});

/** 人看的一行摘要（写日志/文档时用，避免各处自己拼措辞）。 */
export function describeIdentity(key) {
  const row = shopIdentity(key);
  const mark = (value, verified) => {
    if (!value) return '（未实测）';
    // 未知级别退回最保守的措辞「（未实测）」，而不是当成已实测 —— 失败方向朝安全那边倒。
    const label = verified in IDENTITY_VERIFIED_LABEL ? IDENTITY_VERIFIED_LABEL[verified] : '未实测';
    return label ? `${value}（${label}）` : `${value}`;
  };
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
