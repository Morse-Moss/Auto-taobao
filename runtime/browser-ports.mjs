// 项目专用端口与浏览器身份的登记表（唯一来源，2026-09-16 建立）。
//
// 为什么需要它：端口原先散落在 starter、CDP 代理、skill 脚本默认值、文档和测试里，
// 各写一份就会漂移，最后表现为「脚本看起来成功、其实连到了另一个浏览器」
// —— 本项目坑 35（默认值即目标）。2026-09-16 实测到两处实例：
//   1) `runtime/isolated-proxy/browser-discovery.mjs` 的默认浏览器端口是 9223，
//      而 9223 是**日报用的商家浏览器**；裸跑 cdp-proxy 会把自己标成 `edge-isolated`
//      却挂在商家号上（两个账号连的是不同的人）。
//      2026-09-17 已修：三个默认值全部改为本登记表取值（身份=competitor 买家链，与自报的
//      `edge-isolated` 对齐），并把 `isolated-proxy/` 从守卫的跳过名单里移出（见 RETIRED_PORTS 与测试）。
//   2) 日报侧原来用 9223 / 3458：9222/9223 是 Chrome/Edge 远程调试的常见取值，
//      3456/3457/3458 是本机其他项目也在用的一段 —— 撞号后表现为
//      「点击/导航都成功，但操作的是别人的浏览器」。
//
// 选端口的原则：不用「常见默认值 ＋ 1」这种会被别的项目顺手占掉的数。
//   - 竞品链保留 9222 / 3457：历史收据（evidence/ 与 runtime/ 下的 manifest）
//     里记着这两个值，改名会让旧证据对不上（坑 37），收益不抵风险。
//   - 日报链改用 19022 / 19023：与本机其他项目（3456、3458、19000、19001）不重叠。
//
// 账号前提 —— 客户交付必须交代（详见 docs/ops/PROJECT-BROWSER-AND-PORTS.md §1）：
//   生意参谋 / 阿里妈妈 / 飞书 = **商家账号**；小旺神插件 = **只有买家账号能用**。
//   同一个浏览器 profile 不可能同时是商家与买家 ⇒ 两条链必须各自独立实例、
//   独立调试端口、独立代理端口，「省一个浏览器」在这里是行不通的。

export const PROJECT_PORTS = Object.freeze({
  // 竞品链：项目专用调试 Edge（买家号 ＋ 小旺神）
  competitorBrowser: 9222,
  competitorProxy: 3457,
  // 日报链：商家号（生意参谋 / 阿里妈妈 / 飞书）
  dailyReportBrowser: 19022,
  dailyReportProxy: 19023,
  // 运营台（本地控制台，2026-09-16 加）。它不是浏览器端口，但遵循同一条原则：
  // 本项目的每个固定端口只在这里写一次，否则又会变成「默认值即目标」（坑 35）。
  // 只监听 127.0.0.1，不绑 0.0.0.0 —— 它渲染的是登录态与运行状态，不该出本机。
  operatorConsole: 19024,
});

// 退役端口：本项目自己换掉的旧值。
//
// 为什么必须留档（2026-09-17 实测到一例，坑 52）：
//   光把 PROJECT_PORTS 换成新值，并不能让旧值消失 —— 它会以「默认值」的形态继续活着。
//   实测：`runtime/isolated-proxy/browser-discovery.mjs` 的默认浏览器端口仍是 9223（日报链
//   迁移前的值），而同一行自报的身份是 `edge-isolated`（**竞品买家**浏览器）。于是裸跑
//   cdp-proxy 会「自称买家、实连商家」；更麻烦的是导出侧的安全校验是「XWS_BROWSER_ID 与
//   /health 的 browser.id 一致」，两边都来自同一个默认值 ⇒ **校验会过**。
//   而且它躲得过原守卫：`browser-ports.test.mjs` 的「不得写死端口」只扫 PROJECT_PORTS 的
//   现值，9223/3458 不在其中。
//
// 留档 + 让同一个守卫扫它，才能把「退役」从文档里的一句话变成一条可执行的判据。
// `replacedBy` 是 PROJECT_PORTS 的键名（不是端口值），这样原值改了也不会让文档漂移。
export const RETIRED_PORTS = Object.freeze([
  Object.freeze({
    port: 9223,
    replacedBy: 'dailyReportBrowser',
    retiredAt: '2026-09-16',
    reason: '9222/9223 是 Chrome/Edge 远程调试的常见取值，别的项目会顺手占掉；日报链改用 19022。',
  }),
  Object.freeze({
    port: 3458,
    replacedBy: 'dailyReportProxy',
    retiredAt: '2026-09-16',
    reason: '3456/3457/3458 是本机其他项目也在用的一段；日报链代理改用 19023。',
  }),
]);

export function retiredPortNumbers() {
  return RETIRED_PORTS.map((entry) => entry.port);
}

export const BROWSER_IDS = Object.freeze({
  competitor: 'edge-isolated',
  dailyReport: 'edge-daily-report',
});

// /health 里回报的 label。导出侧拿 XWS_BROWSER_ID 跟 /health 的 browser.id 比对，
// 这里对不上就硬失败，所以两份必须同源。
export const BROWSER_LABELS = Object.freeze({
  competitor: 'Microsoft Edge (isolated)',
  dailyReport: 'Microsoft Edge (daily report)',
});

export const BROWSER_PROFILES = Object.freeze({
  competitor: 'D:/Retire/edge-debug-profile',
  dailyReport: 'D:/Retire/edge-daily-report-profile',
});

// ---------------------------------------------------------------------------
// 店铺隔离实例（2026-09-18 加）：「按店铺实例化」的端口与 profile 来源。
// ---------------------------------------------------------------------------
// 为什么需要：日报链原先只有**一个**商家浏览器（dailyReportBrowser 19022），
// 一台机器上只能登一家店；而运营要的是**一轮采五家店**（2026-09-18）。
//
// 三个「不能省」都是实测得来：
//   1) profile 不能共用。一个浏览器 profile 只能是一个淘宝身份（见 BROWSER_ACCOUNT）。
//      这四个 profile 是 2026-09-18 专门为「实人验证一次、长期保活」建的
//      （D:/Retire/edge-profiles/<名>，首次启动带 --disable-sync）。
//   2) 调试端口不能共用。一个浏览器一个调试端口，端口是它的门牌号。
//   3) 代理端口不能共用，而且**必须有**：cdp-proxy「连哪个浏览器」是 **import 期常量**
//      （browser-discovery.mjs 的 ISOLATED_PORT）⇒ 换浏览器要重启进程。
//      而采集脚本（collect-shop-report / collect-promotion-report / readback-daily-report）
//      走的是代理的 /targets /eval /navigate /click /screenshot；裸 CDP 端口只有 /json/list
//      ⇒ 2026-09-18 实测：四个店铺窗口「页面上什么都有，脚本一个也连不上」。
//
// 端口段规划（2026-09-29 扩到 12 家时重排，**旧值一律不动**）：
//   第一批 5 家（2026-09-19 起）：调试 19031-19035 / 代理 19041-19045。
//     ⚠️ 这一批的 10 个端口**不许改** —— `docs/ops/FULL-AUTOMATION-STATE-CONTRACT-2026-09-21.md`
//     与 `evidence/` 下的历史收据按「19041=里可林、19044=科塔」这样逐条记着，
//     改号会让旧证据对不上（坑 37）。所以扩容是**追加**，不是重排。
//   第二批 7 家（2026-09-29 加）：调试 19050-19056 / 代理 19060-19066。
//     为什么单起一段而不是接着 19036 往上排：19041-19045 已经被第一批的代理占住，
//     顺着 19036 排调试会一路撞进那一段（19041/19042 两个号正好撞车）。
//     改成「调试 1905x / 代理 1906x」两块各自连续，是为了让「一眼看出一家店的两个端口」
//     这件事在第二批内部仍然成立（19050↔19060、19051↔19061 …），且与第一批永不交叉。
//   与日报链（19022/19023）、运营台（19024）都不重叠。
//
// 店铺 profile 的「卫生开关」（2026-09-18 的 A/B 实测，见
// docs/ops/MULTI-SHOP-AND-INTERACTION-DECISION.md §5.3.1）：新 profile **首次启动必须带
// `--disable-sync`** —— 不带的话 Edge 会自动登录微软账号并把个人密码库（实测 47 条，
// 还包含当时存在旧 profile 里的**别家店凭据**）同步进来；预置 `signin.allowed=false` 拦不住。
// 这里做成**每次启动都带**而不是「首次记得住」：一次性动作没人记得住，而代价是静默的串号风险。
// 它只作用于声明了它的店铺 profile，两个老浏览器（competitor / dailyReport）argv **逐字不变**
// —— 这条由 browser-ports.test.mjs 断言。
//
// **窗口尺寸（2026-09-28 加，同日真机取证）**：冷启动的 Edge 拿的是 Windows 给的默认窗，
// 实测五店视口一次跑出 **1178x460 / 950x442 / 1528x732**（历史暖启动轮稳定在 1326~1528 × 658~732）。
// 后果不是「难看」，是**落位与取件失败**：`date-picker.mjs` 的 `aim()` 要求元素完整落在视口内，
// 而 `scrollIntoView({block:'nearest'})` 对「已部分可见」的元素**什么都不做**
// ⇒ 按钮贴顶（`rect=[796,0,45,26]`）时判「仍在视口外」并 fail-closed 抛错；
// 取件入口那一处同理（点击后重排，操作行没在采样那一瞬显形）。
// 钉成与历史成功轮一致的值，把「窗口多大」从随机变量变成常量。
// 只作用于店铺 profile ⇒ 两个老浏览器 argv 仍逐字不变。
export const SHOP_BROWSER_WINDOW_SIZE = '--window-size=1528,732';
//
// **强制缩放（2026-10-05 加，同日真机 A/B 取证）—— 让上面那个 1528 真的是 1528。**
//
// 为什么只钉 `--window-size` 不够：它的单位是 **DIP**，而一个 DIP 的物理大小由**系统显示缩放**
// 决定。系统缩放一变，同一个 1528 就代表不同的物理宽度；**物理宽度超过屏幕时窗口会被静默夹掉**，
// 参数照写、日志照绿，只有视口悄悄变小。
//
// 现场（2026-10-05）：系统缩放从 1.25 变 2.5（物理屏 2800×2000 ⇒ 桌面 CSS 只剩 1120×800）
//   ⇒ 1528 DIP 的窗口被夹成 1120 DIP ⇒ 视口从 1506 掉到 **1114**。
//   而阿里妈妈报表页的文档宽是 **1418** ⇒ 视口 < 文档宽 ⇒ 页面被迫横向滚到底，
//   「下载报表」被推到 x=1013..1061，正好压在平台右侧那条**固定挂栏**（在线客服／消息中心，
//   从 ≈1014 起、钉在视口右缘）底下 ⇒ `elementFromPoint` 的 25 个采样点全部命中挂栏
//   ⇒ `命中自己 0/25` ⇒ 复核不通过。8 家店全停在 promotion-submit，
//   而 10-04（视口 1506 > 1418，不横滚，按钮在 x≈1317、挂栏从 ≈1406 起）4 家是过的。
//   **同一份代码、同一个目标日，差的只是窗口能用的宽度。**
//
// 修法：把 DIP 与系统缩放**解耦**。强制 1.25 之后桌面 DIP = 2800/1.25 = 2240
//   ⇒ `--window-size=1528,732` 真正被采纳 ⇒ 视口回到 1506×642。
//
// 取 `1.25` 而不取 `1`：1.25 正是这台机器历史成功轮的缩放值（09-28~10-04 的现场快照
//   `dpr` 恒 1.25），窗口与字号的观感跟用户习惯一致；取 1 会把界面缩得更小。
//   1.25 下可用 DIP 宽度 2240，相对 1528 的请求有 711 的余量。
//
// 真机 A/B 证据（一次性实例：未登记端口 19997/19998 ＋ `D:/Retire/probe-viewport/` 临时 profile）：
//   控制组 `--window-size=1528,732`                        ⇒ 视口 1114x642 / dpr 2.5 / screen 1120x800
//   加本开关 `--window-size=1528,732 --force-device-scale-factor=1.25`
//                                                          ⇒ 视口 1506x642 / dpr 1.25 / avail 2240x1504
//
// ⚠️ 这条只解决了「系统缩放变」。**屏幕物理尺寸变**（换屏、远程桌面改分辨率）仍可能把窗口夹回去，
// 所以「起完实例先回读一次 innerWidth、不达标就别往下跑」那道闸门是另一件事，尚未做。
export const SHOP_BROWSER_SCALE_FACTOR = '--force-device-scale-factor=1.25';
export const SHOP_BROWSER_EXTRA_ARGS = Object.freeze([
  '--disable-sync',
  SHOP_BROWSER_WINDOW_SIZE,
  SHOP_BROWSER_SCALE_FACTOR,
]);
//
// 键 = 运营叫法（与 skills/sycm-alimama-daily-report/scripts/shop-identities.mjs 的
// `key` 同源；`browser-ports.test.mjs` 会交叉核对两边，改名会让测试红而不是静默漂移）。
//
// **2026-09-19 加第五家「盖文天猫」**。用户当日原话：「盖文旗舰店，和盖文全卫定制是两家店……
// 全卫就是盖文淘宝，另一个是天猫……没有专用浏览器就新增一个」。
// 这家店一直有人在采（09-14/15/16 的日报就是它，靠商家浏览器 19022 登着它的商家号），
// 但一登别家就采不到 ⇒ 它需要自己的实例，与另外四家同规格。
export const SHOP_BROWSERS = Object.freeze({
  里可林淘宝: Object.freeze({
    profile: 'D:/Retire/edge-profiles/likelin-home',
    browserPort: 19031,
    proxyPort: 19041,
    browserId: 'edge-shop-likelin-home',
    label: 'Microsoft Edge (shop likelin-home)',
    extraArgs: SHOP_BROWSER_EXTRA_ARGS,
  }),
  网林天猫: Object.freeze({
    profile: 'D:/Retire/edge-profiles/wanglin-flagship',
    browserPort: 19032,
    proxyPort: 19042,
    browserId: 'edge-shop-wanglin-flagship',
    label: 'Microsoft Edge (shop wanglin-flagship)',
    extraArgs: SHOP_BROWSER_EXTRA_ARGS,
  }),
  盖文淘宝: Object.freeze({
    profile: 'D:/Retire/edge-profiles/suixin-custom',
    browserPort: 19033,
    proxyPort: 19043,
    browserId: 'edge-shop-suixin-custom',
    label: 'Microsoft Edge (shop suixin-custom)',
    extraArgs: SHOP_BROWSER_EXTRA_ARGS,
  }),
  盖文天猫: Object.freeze({
    profile: 'D:/Retire/edge-profiles/gaiwen-flagship',
    browserPort: 19035,
    proxyPort: 19045,
    browserId: 'edge-shop-gaiwen-flagship',
    label: 'Microsoft Edge (shop gaiwen-flagship)',
    extraArgs: SHOP_BROWSER_EXTRA_ARGS,
  }),
  科塔淘宝: Object.freeze({
    profile: 'D:/Retire/edge-profiles/shop-j873522735',
    browserPort: 19034,
    proxyPort: 19044,
    browserId: 'edge-shop-j873522735',
    label: 'Microsoft Edge (shop j873522735)',
    extraArgs: SHOP_BROWSER_EXTRA_ARGS,
  }),
  // -------------------------------------------------------------------------
  // 第二批 8 家（5 家 → 13 家；2026-09-30 定稿，同日用户给的《店铺账号信息表》）。
  //
  // **顺序＝部门**：销售1部 8 家在前（上面那 5 家＋本批前 3 家）、销售2部 5 家在后。
  // 顺序不只是好看 —— `planBatches` 按登记表顺序切批，部门连续才让
  // 「一批落在同一个部门的飞书 base 上」这件事尽量成立
  // （飞书目标按月×部门换 base，见 runtime/feishu-targets.mjs 的 PRODUCT_DATA_MONTH_BASES）。
  // 注意仍会有**跨部门的那一批**：13 家按每批 5 家切成 5/5/3，第 2 批必然切在部门边界上
  // （1部后 3 家＋2部前 2 家）。这不影响正确性 —— 每条导入自己按店铺解析 base ——
  // 但报缺口时要按店铺看，不能按批下结论。
  //
  // 这一批的**身份值尚未实测**（`shop-identities.mjs` 里这 8 家仍是 null）。
  // 底座先建好、端口与 profile 先定死；身份值等人工在这台机器上逐店登录一次、
  // 用只读探针读出来再回填 —— **不许派生、不许猜**（实测已推翻「会员名＝店名:阿彦」）。
  //
  // profile 名一律小写 ASCII 与连字符，规则：
  //   · 用例断言 `^[a-z0-9-]+$`；
  //   · **一店一目录**，绝不共用（共用 profile ＝ 两个淘宝身份混在一个浏览器里，
  //     Chromium 会自己挑一条凭据，登错店不报错 —— 2026-09-23 实测过）。
  //   · 每个目录都还没有实体，首次由 `start-all.mjs` / 启动器按需创建；
  //     建好后在这台机器上人工登一次并点「保存密码」。
  //
  // 端口：调试 19050-19057 / 代理 19060-19067（同尾数配对）。
  // ⚠️ 这一段是 2026-09-30 起用的**全新号段**，此前未进过任何历史收据，
  //    所以按部门重排时连号一起重排是安全的（第一批 19031-19035 则**只许追加**，见上）。
  // -------------------------------------------------------------------------
  // --- 销售1部（本批 3 家，接在上面 5 家之后） ---
  网林淘宝: Object.freeze({
    profile: 'D:/Retire/edge-profiles/wanglin-taobao',
    browserPort: 19050,
    proxyPort: 19060,
    browserId: 'edge-shop-wanglin-taobao',
    label: 'Microsoft Edge (shop wanglin-taobao)',
    extraArgs: SHOP_BROWSER_EXTRA_ARGS,
  }),
  里可林天猫: Object.freeze({
    profile: 'D:/Retire/edge-profiles/likelin-tmall',
    browserPort: 19051,
    proxyPort: 19061,
    browserId: 'edge-shop-likelin-tmall',
    label: 'Microsoft Edge (shop likelin-tmall)',
    extraArgs: SHOP_BROWSER_EXTRA_ARGS,
  }),
  网林家居: Object.freeze({
    profile: 'D:/Retire/edge-profiles/wanglin-custom',
    browserPort: 19052,
    proxyPort: 19062,
    browserId: 'edge-shop-wanglin-custom',
    label: 'Microsoft Edge (shop wanglin-custom)',
    extraArgs: SHOP_BROWSER_EXTRA_ARGS,
  }),
  // --- 销售2部（5 家） ---
  保拉淘宝: Object.freeze({
    profile: 'D:/Retire/edge-profiles/paola-taobao',
    browserPort: 19053,
    proxyPort: 19063,
    browserId: 'edge-shop-paola-taobao',
    label: 'Microsoft Edge (shop paola-taobao)',
    extraArgs: SHOP_BROWSER_EXTRA_ARGS,
  }),
  保拉天猫: Object.freeze({
    profile: 'D:/Retire/edge-profiles/paola-tmall',
    browserPort: 19054,
    proxyPort: 19064,
    browserId: 'edge-shop-paola-tmall',
    label: 'Microsoft Edge (shop paola-tmall)',
    extraArgs: SHOP_BROWSER_EXTRA_ARGS,
  }),
  安比龙头店: Object.freeze({
    profile: 'D:/Retire/edge-profiles/anbi-leading',
    browserPort: 19055,
    proxyPort: 19065,
    browserId: 'edge-shop-anbi-leading',
    label: 'Microsoft Edge (shop anbi-leading)',
    extraArgs: SHOP_BROWSER_EXTRA_ARGS,
  }),
  科塔龙头店: Object.freeze({
    profile: 'D:/Retire/edge-profiles/keta-leading',
    browserPort: 19056,
    proxyPort: 19066,
    browserId: 'edge-shop-keta-leading',
    label: 'Microsoft Edge (shop keta-leading)',
    extraArgs: SHOP_BROWSER_EXTRA_ARGS,
  }),
  安比淘宝: Object.freeze({
    profile: 'D:/Retire/edge-profiles/anbi-taobao',
    browserPort: 19057,
    proxyPort: 19067,
    browserId: 'edge-shop-anbi-taobao',
    label: 'Microsoft Edge (shop anbi-taobao)',
    extraArgs: SHOP_BROWSER_EXTRA_ARGS,
  }),
});

export function shopBrowserKeys() {
  return Object.keys(SHOP_BROWSERS);
}

/**
 * **已登记、但还没有开始收集数据**的店铺。**当前为空**（2026-09-30 晚起 13 家全采）。
 *
 * 为什么要分成「登记」与「参与收集」两个概念 —— 不是洁癖，是因为
 * 把一家空店留在采集默认名单里，后果**不是「多跑一家」，而是整轮失败或天天假告警**：
 *   ① 日报链 `buildShopStages` 要求身份齐全（页头店名实测过）；
 *   ② 商品数据链的登录预检是**一次调用查全部店、不通过就整轮中止**
 *      （`run-product-data-job.mjs` 那句 `if (login.code !== 0) throw`）⇒ 一家没登录，全部不采；
 *   ③ 写入落点：日报链回填按「店铺」这个**单选选项**匹配，当月 base 里没有它就直接 fail-closed。
 *
 * 沿革（一句话）：2026-09-30 白天新加第 13 家「网林家居」（当天 11:05 那版账号表里简称还叫
 * 「网林定制淘宝」，15:43 起改成现名），上午先把它挂进这张表挡住采集；当天晚些时候
 * 三件事陆续到位 —— ① 13 家身份全部实测并回填 `shop-identities.mjs`（`expression` 级）；
 * ② 换到新日报 base「各店铺日报 副本」，其「店铺」选项已有 13 项、09-29…10-05 预建行也按 13 家铺好
 *      （商品链**不需要**这个选项：三张被写的底单一个「店铺」列都没有，看板上的「店铺」是
 *      type 19 引用/lookup，不可写）；③ 实例/端口/代理/标识页本来就按登记表走。
 * 于是用户拍板「肯定开 13 家啊」，这张表清空 ⇒ `collectingShopKeys()` 与
 * `shopBrowserKeys()` **逐字相同**（13 家），这是**期望形态**，不是判据失效。
 *
 * 表**留着不删**：「先建底座、观察一两天、再让它进采集名单」是这套流程的常规节拍，
 * 下次加店或换操作员时把新店名填回来即可 —— `collectingShopKeys()` 会自动把它从两条链的
 * 默认名单里摘掉，两个函数也各自有 fail-closed 的「还没开始收集」报错分支（措辞与「未登记」分开）。
 *
 * 它**不影响实例侧**（`start-all` / `stop-all` / `browser-inventory` / 标签页 / 身份实测）
 * 那些一律按 `shopBrowserKeys()` 走 —— 表里有的店照样要起、要登录、要挂标识页。
 *
 * 2026-10-05 用户指令「销售二部的全停止」⇒ 把销售2部 5 家（`feishu-targets.mjs` 的
 * `SHOP_DEPARTMENTS` 里 `sales2` 那组：保拉淘宝、保拉天猫、安比龙头店、科塔龙头店、安比淘宝）
 * 填进这张表。**两条采集链一起停**（日报链 + 商品数据链），实例侧不受影响。
 * 这不是「暂缓一家新店」，是**整部门停采**，所以下面那句「两者逐字相同」不再成立。
 * 恢复：把这 5 行删掉即可（表留着的意义正在这里）。
 */
export const SHOPS_NOT_COLLECTING_YET = Object.freeze([
  '保拉淘宝',
  '保拉天猫',
  '安比龙头店',
  '科塔龙头店',
  '安比淘宝',
]);

/**
 * 参与采集的店铺（顺序＝登记表顺序）。
 * **两条采集链的默认名单都用它**，不是 `shopBrowserKeys()` —— 那张「待收集」表非空时两者会不同
 * （2026-10-05 起：登记表 13 家、参与采集 8 家＝销售1部；判据在 `browser-ports.test.mjs`）。
 */
export function collectingShopKeys() {
  return shopBrowserKeys().filter((key) => !SHOPS_NOT_COLLECTING_YET.includes(key));
}

/** 按运营叫法取店铺实例。**未登记一律抛错**（fail-closed），不回落成「随便连一个」。 */
export function shopInstance(key) {
  const found = SHOP_BROWSERS[key];
  if (!found) {
    throw new Error(`未登记的店铺实例「${key}」；已登记：${shopBrowserKeys().join(' / ')}`);
  }
  return found;
}

/**
 * 这个 profile 启动时该额外带哪些 Chromium 开关。
 *
 * 只有登记在 SHOP_BROWSERS 里的店铺 profile 会拿到（当前＝`--disable-sync`）。
 * 空数组 = 与历史行为**逐字相同** —— 两个老浏览器（competitor / dailyReport）
 * 既不在 BROWSER_PROFILES 的店铺表里、也不在 SHOP_BROWSERS 里，所以它们一个额外参数都不会多。
 * 认不出 profile（比如手工起的临时目录）时也返回空数组，不猜。
 */
export function extraArgsForProfile(profile) {
  const target = normalizeProfile(profile);
  if (target === null) return [];
  const hit = Object.values(SHOP_BROWSERS).find((entry) => normalizeProfile(entry.profile) === target);
  return hit?.extraArgs ? [...hit.extraArgs] : [];
}

/**
 * 启动器的 argv。抽成纯函数只为一件事：让「新开关不许外溢到别的浏览器」这条约束
 * 能被离线断言（启动脚本本身一 import 就会起浏览器，测不了）。
 */
export function buildBrowserLaunchArgs({ profile, port, startUrl = 'about:blank' }) {
  return [
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${port}`,
    '--no-first-run',
    '--no-default-browser-check',
    ...extraArgsForProfile(profile),
    startUrl,
  ];
}

/**
 * 本项目声明的**全部**固定端口（两个链 + 运营台 + 每个店铺实例的两个端口）。
 * 「生产代码里不得写死端口」那条守卫要扫的就是这一份 —— 只扫 PROJECT_PORTS 的话，
 * 店铺端口会成为新的法外之地（正是坑 52 的形态：换个名字继续写死）。
 */
export function allDeclaredPorts() {
  return [
    ...Object.values(PROJECT_PORTS),
    ...Object.values(SHOP_BROWSERS).flatMap((entry) => [entry.browserPort, entry.proxyPort]),
  ];
}

// ---------------------------------------------------------------------------
// 三条业务路线（关键词 / 竞品 / 日报）× 两个浏览器的归属，2026-09-16 定。
// ---------------------------------------------------------------------------
// 分线的判据不是「哪个 skill 顺手」，而是**站点要哪种账号**：
//   淘宝（买家视角、配小旺神插件）        → 买家浏览器 competitor
//   生意参谋 / 千牛 / 阿里妈妈（商家后台） → 商家浏览器 dailyReport
//
// 一个浏览器 profile 只能是一个淘宝身份。把商家号登进买家浏览器，小旺神采集会
// **静默退化**：页面能打开、导出能成功，但商品详情页看不到别家数据、小旺神面板读不出
// 市场数据（错误发生在数据层，而不是点击层）。反过来把买家号登进商家浏览器，
// 生意参谋直接停在登录墙。
// 用户原话：「卖家版的账号是用不了小旺神的，主要是规避这个风险」。
//
// 第三方平台（灰豚、飞书）用的是它自己的账号，与淘宝身份无关，
// 所以跟哪个浏览器同住都不冲突 —— 不冲突的前提是它**不受**淘宝登录态影响。
export const ACCOUNT_KINDS = Object.freeze({
  buyer: 'buyer',
  merchant: 'merchant',
  independent: 'independent',
});

// 站点 → 它要求的账号类型。写全是为了 fail-closed：
// 路线表里出现未登记的站点时单测直接失败，而不是「没人说得清这个站属于哪一边」。
export const SITE_ACCOUNT = Object.freeze({
  's.taobao.com': ACCOUNT_KINDS.buyer,
  'item.taobao.com': ACCOUNT_KINDS.buyer,
  'detail.tmall.com': ACCOUNT_KINDS.buyer,
  'sycm.taobao.com': ACCOUNT_KINDS.merchant,
  'one.alimama.com': ACCOUNT_KINDS.merchant,
  'myseller.taobao.com': ACCOUNT_KINDS.merchant,
  'qianniu.taobao.com': ACCOUNT_KINDS.merchant,
  'xhs.huitun.com': ACCOUNT_KINDS.independent,
  'dy.huitun.com': ACCOUNT_KINDS.independent,
  'feishu.cn': ACCOUNT_KINDS.independent,
});

// 每个浏览器承载的淘宝身份。这是「不能合并」的根因所在。
export const BROWSER_ACCOUNT = Object.freeze({
  competitor: ACCOUNT_KINDS.buyer,
  dailyReport: ACCOUNT_KINDS.merchant,
});

// 路线表。`browser: null` ＝ 这条链不需要浏览器（纯接口），或归属尚未定 —— 那时必须显式带
// `browserPending: true` + `pendingReason`，把「待决」本身变成一个可被测试盯住的事实，
// 而不是一句口口相传的待办。当前 7 条路线里没人走「待定」这一支（灰豚 2026-09-16 已定归乙），
// 但机制留着：将来再加一条归属未明的链，测试会逼着它把话说清楚。
export const ROUTES = Object.freeze({
  competitor: Object.freeze({
    label: '竞品（小旺神市场分析 / SKU / FAQ / 词库采集）',
    browser: 'competitor',
    account: ACCOUNT_KINDS.buyer,
    sites: Object.freeze(['s.taobao.com', 'item.taobao.com', 'detail.tmall.com']),
    needsExtension: '小旺神',
    skills: Object.freeze([
      'xws-export-market-analysis',
      'xws-sku-collection',
      'xws-faq-operator',
      'xws-faq-raw-collection',
      'xws-question-library-collection',
    ]),
  }),
  competitorImport: Object.freeze({
    label: '竞品入库（小旺神导出 → 飞书 API）',
    browser: null,
    noBrowser: true,
    noBrowserReason: '上传走飞书开放接口，不开浏览器、不读登录态；照片附件也走接口。',
    account: ACCOUNT_KINDS.independent,
    sites: Object.freeze(['feishu.cn']),
    needsExtension: null,
    skills: Object.freeze(['xws-to-feishu-base']),
  }),
  keywordRank: Object.freeze({
    label: '关键词·搜索排行（生意参谋）',
    browser: 'dailyReport',
    account: ACCOUNT_KINDS.merchant,
    sites: Object.freeze(['sycm.taobao.com']),
    needsExtension: null,
    skills: Object.freeze(['sycm-export-search-rank']),
  }),
  keywordHeat: Object.freeze({
    label: '关键词·灰豚话题热度（小红书）',
    // 2026-09-16：归属已定 —— 归乙。因为它的代码默认值（proxy + browserId）已经
    // 落在乙上（见 skills/huitun-to-feishu-keyword-heat/scripts/flow.mjs），
    // 这里再写 browser: null 就是「代码说乙、登记表说待定」的自相矛盾。
    browser: 'dailyReport',
    // 灰豚是第三方平台，用它自己的账号，与淘宝身份无关 —— 放乙是决定而非必然，
    // 所以如实写 independent，不写成 merchant 冒充必然性。
    account: ACCOUNT_KINDS.independent,
    sites: Object.freeze(['xhs.huitun.com', 'dy.huitun.com']),
    needsExtension: null,
    skills: Object.freeze(['huitun-to-feishu-keyword-heat']),
  }),
  dailyReport: Object.freeze({
    label: '日报（生意参谋 + 万相台/阿里妈妈 + 飞书）',
    browser: 'dailyReport',
    account: ACCOUNT_KINDS.merchant,
    sites: Object.freeze(['sycm.taobao.com', 'one.alimama.com', 'feishu.cn']),
    needsExtension: null,
    skills: Object.freeze(['sycm-alimama-daily-report', 'sycm-inquiry-data', 'sycm-product-data', 'sycm-promotion-data']),
  }),
  weeklyPaste: Object.freeze({
    label: '周表粘贴（周表 → 飞书网页）',
    browser: 'dailyReport',
    // 飞书用的是它自己的账号，与淘宝身份无关 —— 放乙是**决定而非必然**（乙是运营侧那个浏览器，
    // 飞书登录态跟着它走），所以这里如实写 independent，不写成 merchant 冒充必然性。
    account: ACCOUNT_KINDS.independent,
    sites: Object.freeze(['feishu.cn']),
    needsExtension: null,
    skills: Object.freeze(['sycm-to-feishu-base']),
  }),
  sellerWorkbench: Object.freeze({
    label: '千牛 / 卖家工作台（预留：仓库内暂无调用方）',
    browser: 'dailyReport',
    account: ACCOUNT_KINDS.merchant,
    sites: Object.freeze(['myseller.taobao.com', 'qianniu.taobao.com']),
    needsExtension: null,
    skills: Object.freeze([]),
  }),
});

export function routesOnBrowser(browserKey) {
  return Object.entries(ROUTES)
    .filter(([, route]) => route.browser === browserKey)
    .map(([name]) => name);
}

// 给启动器念的一句话：这个端口承载哪几条路线、必须登哪种账号。
export function describeBrowserRoutes(browserKey) {
  const names = routesOnBrowser(browserKey);
  const kinds = new Set(names.map((name) => ROUTES[name].account));
  const ext = names.map((name) => ROUTES[name].needsExtension).filter(Boolean);
  const parts = [`账号=${[...kinds].join('/') || '(无路线)'}`];
  if (ext.length > 0) parts.push(`插件=${[...new Set(ext)].join('/')}`);
  parts.push(`路线=${names.join(', ') || '(无)'}`);
  return parts.join(' ');
}

// 别的项目的端口 —— 记下来是为了**避开**，不是为了兜底。
// 3456 是别的项目的共享 CDP 代理，挂在用户的日常 Edge 上：那里登的是商家账号，
// 而且**没装小旺神**（见 docs/ops/PROJECT-BROWSER-AND-PORTS.md §3）。
export const FOREIGN_PORTS = Object.freeze({
  sharedProxy: 3456,
});

// 「生产代码里不得出现别的项目的代理地址」这条守卫的判据。
// 只认**带 scheme 的 URL 字面量**（http(s)://<host>:3456）：
//   - 注释里写清「别碰 3456」要放过 —— 那种提到是好事，不该被守卫逼着删掉；
//     （调用方先对 .mjs 去注释再匹配，见 runtime/browser-ports.test.mjs）
//   - `127.0.0.1:3456` 这种不带 scheme 的说明性文字也放过。
export const FOREIGN_PROXY_URL_PATTERN = /https?:\/\/(?:127\.0\.0\.1|localhost):3456/;

// 例外清单：允许保留这个 URL 字面量的文件（**2026-09-16 起为 0**）。
// 2026-09-16 那轮把 31 处默认值全部迁到本登记表：灰豚与飞书网页登录态归乙（dailyReportProxy），
// 生意参谋搜索排行与周表粘贴归乙，竞品导出归甲（competitorProxy）。
// 清单必须与实际逐字一致（双向）：写死一处就会让测试红，而不是等到别人关掉代理才炸
// （坑 35 默认值即目标 ＋ 坑 38 能力删在生产者、故障显在消费者）。
export const FOREIGN_PROXY_ALLOWED_FILES = Object.freeze([]);

// 显式传了环境变量就用显式的，否则回落到登记表；非法值直接抛错而不是静默取默认
// （「静默回落」正是坑 35 的成因）。
export function resolvePort(envName, fallback) {
  const raw = process.env[envName];
  const value = Number(raw ?? fallback);
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error(`${envName} 必须是 1-65535 的整数端口，收到 ${JSON.stringify(raw)}`);
  }
  return value;
}

export function normalizeProfile(value) {
  if (typeof value !== 'string') return null;
  // 先 trim 再剥尾斜杠：`"D:\a\b" `（尾部带空格）与 `D:/a/b/` 必须归一到同一个字符串，
  // 否则同一个 profile 会因为写法不同被判成「别人的浏览器」而拒绝启动。
  const stripped = value.trim().replaceAll('\\', '/').replace(/\/+$/, '');
  return stripped.length > 0 ? stripped.toLowerCase() : null;
}

// 从 CDP `SystemInfo.getInfo` 的 commandLine 里取 --user-data-dir。
// 这是**唯一**能证明「这个端口上的浏览器是不是我们的那个 profile」的证据源：
// /json/version 只给 Browser / User-Agent，给不出 profile。
export function extractProfileFromCommandLine(commandLine) {
  if (typeof commandLine !== 'string') return null;
  const match = commandLine.match(/--user-data-dir=(?:"([^"]+)"|(\S+))/);
  const raw = match?.[1] ?? match?.[2] ?? null;
  return raw === null ? null : raw.trim().replaceAll('\\', '/').replace(/\/+$/, '');
}

async function isPortListening(port, timeoutMs) {
  const net = await import('node:net');
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    const finish = (value) => { socket.destroy(); resolve(value); };
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.setTimeout(timeoutMs, () => finish(false));
  });
}

async function readCommandLineViaCdp(wsUrl, timeoutMs) {
  if (typeof WebSocket === 'undefined' || !wsUrl) return null;
  return new Promise((resolve) => {
    let socket = null;
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket?.close(); } catch { /* 已经关了 */ }
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    try {
      socket = new WebSocket(wsUrl);
    } catch {
      finish(null);
      return;
    }
    socket.addEventListener('error', () => finish(null));
    socket.addEventListener('open', () => {
      socket.send(JSON.stringify({ id: 1, method: 'SystemInfo.getInfo' }));
    });
    socket.addEventListener('message', (event) => {
      let message;
      try {
        message = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data));
      } catch {
        return;
      }
      if (message?.id !== 1) return;
      finish(typeof message.result?.commandLine === 'string' ? message.result.commandLine : null);
    });
  });
}

// 端口上现在到底是什么？
//   free                   端口没在监听
//   occupied               有 CDP 端点，可读出 Browser / profile
//   occupied-unidentified  端口在监听但 /json/version 读不出来（不是浏览器，或还没就绪）
export async function inspectPort(port, options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 1500;
  const version = await (async () => {
    try {
      const response = await fetchImpl(`http://127.0.0.1:${port}/json/version`, {
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) return null;
      return await response.json();
    } catch {
      return null;
    }
  })();
  if (!version) {
    const listening = await (options.listeningProbe ?? isPortListening)(port, timeoutMs);
    return { status: listening ? 'occupied-unidentified' : 'free' };
  }
  const wsUrl = version.webSocketDebuggerUrl ?? null;
  const commandLine = wsUrl
    ? await (options.commandLineReader ?? readCommandLineViaCdp)(wsUrl, timeoutMs)
    : null;
  return {
    status: 'occupied',
    product: version.Browser ?? null,
    userAgent: version['User-Agent'] ?? null,
    webSocketDebuggerUrl: wsUrl,
    commandLine,
    profile: extractProfileFromCommandLine(commandLine),
  };
}

// 只对「有正面证据」的冲突下判决：读出了 --user-data-dir 且与期望不一致才判 foreign。
// 读不出来（unknown）只警告不拦 —— 凭「探针没读到」停线，会让一次网络抖动变成一次事故。
export function classifyPortUsage(inspection, { expectedProfile } = {}) {
  if (inspection.status === 'free') return { verdict: 'free' };
  const expected = normalizeProfile(expectedProfile);
  const actual = normalizeProfile(inspection.profile);
  if (actual !== null && expected !== null) {
    return actual === expected
      ? { verdict: 'ours', profile: inspection.profile }
      : { verdict: 'foreign', profile: inspection.profile };
  }
  return { verdict: 'unknown', profile: inspection.profile ?? null, status: inspection.status };
}

// 给启动器用的一句话交代（谁占了我的端口、该怎么处理）。
export function describeOccupant(inspection) {
  const parts = [`product=${inspection.product ?? '(未识别)'}`];
  parts.push(`profile=${inspection.profile ?? '(未识别)'}`);
  if (inspection.status === 'occupied-unidentified') parts.push('（端口在监听，但不是可读的 CDP 端点）');
  return parts.join(' ');
}