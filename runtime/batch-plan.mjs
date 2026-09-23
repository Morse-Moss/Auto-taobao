// 分批跑日报链：**「这一轮该切成几批、每批跑哪几家、每批执行哪四条命令」的唯一口径**。
//
// 为什么需要这一层（2026-09-23 用户原话）：
//   「跑完要释放，因为后续要跑更多店铺，全部店铺都不释放，电脑性能撑不住」；
//   「1.起点1.0.0 / 2.按你推荐的来 / 3.允许 / 4.先按你推荐的来 / 5.失败优先解决问题，
//     需要人工的就转人工」。
//
// 三条已实测的前提（**别重推**，它们决定了这里为什么长这样）：
//   1) **瓶颈是内存不是 CPU**：每实例 0.9–2.0 GB／约 15 个进程（均值约 1.7 GB）。
//      所以「一轮几家」不是旋钮、「**同时开着几个实例**」才是 —— 分批是正确形态。
//   2) **清页签省不了内存**（实测 6297→6726 MB），能省的只有「关掉整个实例」。
//   3) 峰值 ≈ `N×1.7 GB ＋ 商家浏览器 1.5 GB` ⇒ 档位：8 GB→N=2、16 GB→N=4、32 GB→N=5。
//      出处 docs/ops/CLIENT-MACHINE-CAPACITY.md（那份文档 §4 同时写着「现在**没有**
//      『按店铺起浏览器／分批／跑完关掉』的驱动」—— 本文件就是补上它的那一层）。
//
// 四条设计约束：
//   1) **纯函数**：只算「该跑哪几条命令」，不 spawn、不探测、不读进程表、不读时钟。
//      于是它可以被离线用例完整断言，而 run-batches.mjs 只剩下真正的 I/O。
//   2) **不写死端口、不写死店名**：店名与顺序一律取自登记表（browser-ports.mjs），
//      端口一个都不出现。同一件事两处实现，最后一定是两处不一致。
//   3) **起与停作用在同一组目标上**：同一批的 `--only` 名单**由同一个变量渲染**，
//      不给「起的时候 3 家、停的时候 2 家」留缝 —— 剩下那家会永远活着，而且没有任何一处会报错。
//   4) **默认与今天逐字相同**：本层只有在被显式调用时才产生批次；「不开启」这条路由
//      runtime/daily-job-plan.mjs 负责保证（它不加 `--batches` 时一个字符都不变）。
//
// 停的判据**不在这里**：释放能不能落地，取决于 stop-all 那三类必须来自进程自身的证据
// （见 runtime/launch-plan.mjs 的 planInstanceStop 与 scripts/stop-all.mjs）。
// 本层只决定**该不该发起释放**，不决定「能不能停」——两件事混在一起会写出一个
// 「以为停了、其实拒停了」的假成功。
import { shopBrowserKeys, shopInstance } from './browser-ports.mjs';

/** 每一段做什么，用哪个脚本（路径相对仓库根）。**显式表，不按 kind 拼文件名**。 */
export const BATCH_FILES = Object.freeze({
  // 起这一批（幂等：已就位的不碰）。
  start: 'scripts/start-all.mjs',
  // 挂店铺标识页（接管本批浏览器里的空白页，幂等）。
  label: 'runtime/shop-window-label.mjs',
  // 跑这一批。`--shops` 只给本批，所以「跑完了」这句话的涵义是「本批跑完了」。
  chain: 'skills/sycm-alimama-daily-report/scripts/run-multi-shop-day.mjs',
  // 停这一批（**默认只打印**，要真停必须 `--yes`；本层会显式加上）。
  stop: 'scripts/stop-all.mjs',
});

/**
 * **不随批次起停**的共享实例：链要它们，但它们不是「店铺」，所以整轮都不动。
 *
 * 为什么必须有这一步：`run-multi-shop-day.mjs` 有一句明写的实现事实 ——
 * 「一轮一次：商家浏览器的体检。推送段与回读段都跑在它上面，而飞书底单页只在那一个浏览器里」。
 * 少了它，整轮会在体检那一步就全败（而失败原因看起来像「今天的页面不齐」）。
 * 定时链那边是第①步 `ensure-instances` 起齐全部 7 个，所以这一步在定时形态下是幂等的空动作；
 * 单独用 `run-batches` 时它才是必需的那一步。
 *
 * 为什么**只有**商家浏览器、不含竞品链：这条链（日报）不读竞品链的买家号浏览器。
 * 把不需要的实例一起起来是白占内存 —— 而「省内存」正是本功能存在的理由；
 * 竞品链有自己的排期，不该被日报的批次顺手牵起来。
 */
export const SHARED_INSTANCE_KEYS = Object.freeze(['dailyReport']);

/** 整轮一次的前置：保证共享实例在。**只有起、没有对应的停**（它们不随批次回收）。 */
export function buildSharedStep() {
  return {
    name: 'ensure-shared',
    file: BATCH_FILES.start,
    args: ['--only', SHARED_INSTANCE_KEYS.join(',')],
    blocking: false,
    note: `保证共享实例在（${SHARED_INSTANCE_KEYS.join('、')}）—— 推送段与回读段跑在它上面；整轮都不停它`,
  };
}

/**
 * 本地跑批的默认每批家数。
 *
 * 取 5 而不是 3：本机 32 GB 档位实测能同时开 5–6 个实例，而「一批跑完五家店」与今天的行为
 * 最接近（今天就是一次全起）—— 默认值改变行为的地方越少，第一次真跑能暴露的问题越单纯。
 * 客户机上这个值必须按内存档位下调（见 BATCH_SIZE_BY_MEMORY 与 CLI 的 `--batch-size`）。
 */
export const DEFAULT_BATCH_SIZE = 5;

/**
 * 内存档位 → 每批家数（客户机用）。
 *
 * 这张表是**估算的落点，不是实测的结论**：本机只实测过 32 GB 下 5–6 个实例同时开着
 * （见 CLIENT-MACHINE-CAPACITY.md）。所以它只作为「建议值」被人抄进命令行，
 * **不做成自动探测** —— 自动探测要么读 WMI（本机与客户机口径不一），
 * 要么靠猜，而猜错的代价是客户机被换页拖死。宁可让人显式给一个数。
 */
export const BATCH_SIZE_BY_MEMORY = Object.freeze({
  '8GB': 2,
  '16GB': 4,
  '32GB': 5,
});

/** 本层认得的店铺＝登记表里的全部店铺实例（顺序＝登记表顺序，也就是人抄下来的顺序）。 */
export function batchableShopKeys() {
  return shopBrowserKeys();
}

/**
 * 解析 `--batch-size`。**非法值当场抛错，不回落默认**。
 *
 * 为什么这条要紧：一个拼错的 `--batch-size=1O`（字母 O）若静默回落成 5，
 * 客户机上就会一次性开 5 个实例 —— 而那次的结果是整机卡死，不是报错。
 * 数字参数上「宽容」没有收益，只有风险。
 */
export function resolveBatchSize(raw, { fallback = DEFAULT_BATCH_SIZE } = {}) {
  if (raw === null || raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`每批家数必须是 ≥1 的整数，收到 ${JSON.stringify(raw)}（例如 --batch-size 2）`);
  }
  if (value > 32) {
    throw new Error(`每批家数 ${value} 大到不像话（本机 32 GB 实测上限 5–6 个实例）—— 确认一下是不是打错了`);
  }
  return value;
}

/**
 * 把店铺名字（运营叫法或内部键）翻成登记表里的键，并**拒绝不认识的**。
 *
 * 与 start-all/stop-all 的 `--only` 同一条口径：拼错不静默回落。
 * 回落的表现是「跑完了，但那一家根本没被处理」，一个不会报错的漏做。
 */
export function resolveShopNames(names) {
  const known = batchableShopKeys();
  if (!names || names.length === 0) return known;
  const unknown = names.filter((name) => !known.includes(name));
  if (unknown.length > 0) {
    throw new Error(`不认识的店铺：${unknown.join('、')}\n已登记：${known.join(' / ')}`);
  }
  // 去重但保持「登记表顺序」而不是「输入顺序」：批次的顺序也是行为的一部分
  // （五家店的顺序里科塔在最后 —— 它失败挡不住前四家），所以不让人随手打乱。
  return known.filter((name) => names.includes(name));
}

/**
 * 切批。**纯函数**，只做「怎么分」。
 *
 * 三条不变量（由 batch-plan.test.mjs 断言，因为它们错了会静默漏做）：
 *   · 覆盖：拼起来正好是入参那几家，一家不多一家不少；
 *   · 不重：同一家不许出现在两批里（两批同时开同一家 = 串店的现实版本）；
 *   · 有序：批内与批间都保持登记表顺序（下面按登记表顺序切，不做任何排序）。
 */
export function planBatches({ shops = null, size = DEFAULT_BATCH_SIZE } = {}) {
  const keys = resolveShopNames(shops);
  const chunk = resolveBatchSize(size);
  const batches = [];
  for (let i = 0; i < keys.length; i += chunk) {
    batches.push({ index: batches.length + 1, shops: keys.slice(i, i + chunk) });
  }
  return { size: chunk, total: batches.length, shops: keys, batches };
}

/** 这一批的开跑对象：**起、挂标识页、跑、停四段共用同一份名单**。 */
export function batchOnlyArgs(batch) {
  return ['--only', batch.shops.join(',')];
}

/**
 * 一个批次的四段命令。返回顺序**就是执行顺序**，每一步都带 `blocking`：
 *   start  —— 失败则跳过链（起不来就采不到），但**仍然发起释放**（别留半批占内存）；
 *   label  —— 每家一条（shop-window-label 的 `--only` 只收一个店名，且它是幂等的）。
 *             失败不算致命：标识页只是给人看的，缺了它数据照样收；
 *             所以 `blocking: false`，但失败会被记下来（「窗口上没写店名」是用户明确投诉过的现象）。
 *   chain  —— 唯一判「这一批成不成」的那一步；
 *   stop   —— 显式带 `--yes`（stop-all 的默认是只打印；在编排里只打印等于没释放）。
 */
export function buildBatchSteps(batch, { dateInput = 'yesterday', chainArgs = [], logsDir = null } = {}) {
  return [
    {
      name: 'start',
      file: BATCH_FILES.start,
      args: batchOnlyArgs(batch),
      blocking: true,
      note: `起这一批 ${batch.shops.length} 家（幂等：已就位的不碰）`,
    },
    ...batch.shops.map((shop) => ({
      name: `label:${shop}`,
      file: BATCH_FILES.label,
      // `--front`：把标识页置前，窗口标题＝店名 —— 业务人员走到机器前一眼能对上。
      // 不带 `--prune`：那个开关是**独占意图**，而且它在 main() 里排在挂标签页之前，
      // 一起给会让「原地接管空白页」这条路走不到（详见 shop-window-label.mjs 的 CLI 注释）。
      // 冷启动后每个窗口恰好一个空白页，接管它就已经没有残留了，prune 在这里是多余动作。
      args: ['--commit', '--front', '--only', shop],
      blocking: false,
      note: `给 ${shop} 挂/更新窗口标识页（接管空白页，顺带置前）`,
    })),
    {
      name: 'chain',
      file: BATCH_FILES.chain,
      // `--logs` 写在这里而不是由 IO 层在 spawn 那一刻补：**打印出来的必须是真正执行的**
      // （本仓库吃过这个亏 —— 打印与执行不一样时，事后照打印的那行手工复现会得到另一个结果）。
      // 一批一个子目录：链把 summary.json 写在 `--logs` 根上，共用一个根会互相覆盖。
      args: [
        '--date', dateInput, '--shops', batch.shops.join(','), ...chainArgs,
        ...(logsDir ? ['--logs', logsDir] : []),
      ],
      blocking: true,
      note: `跑这一批：体检 → 采集 → 推送 → 回填 → 回读（只跑 ${batch.shops.join('、')}）`,
    },
    {
      name: 'stop',
      file: BATCH_FILES.stop,
      args: ['--yes', ...batchOnlyArgs(batch)],
      blocking: false,
      note: `停这一批（只停本批店铺的浏览器与代理；商家浏览器与竞品链一律不动）`,
    },
  ];
}

/**
 * 这一轮跑完之后，**该不该发起释放**。
 *
 * 用户第 5 条的拍板原话：「失败优先解决问题，需要人工的就转人工」。
 * 落成判决就是这一条：
 *   · 链没跑成（status ≠ 0）⇒ **不释放**。不主动把排查现场收掉，释放随时可以补做
 *     （命令就在下面这行 `why` 里），而复现一次失败要再花一整个批次的时间。
 *   · 链没跑（status === null）⇒ 释放。没有「现场」可言，留着只是占内存。
 *   · 链成功 ⇒ 释放。这才是这条链存在的全部收益所在。
 *
 * 注意这**不是**「停第一遍」：真正能不能停由 stop-all 的三类证据决定
 * （foreign / unconfirmed 一律拒停）。本函数只回答「要不要发起」。
 *
 * ⚠️ 关于「留着窗口等人看」这句话 —— 2026-09-23 真机实测后改成实话（见 `caveat`）：
 * 本文件批次里的 `start` 走的是 `scripts/start-all.mjs`（**起完就退**），而宿主在命令结束时
 * 回收的是**整棵进程树**；于是「不释放」只等于「我不去停它」，**不等于「它还活着」** ——
 * 实测里那批窗口在命令结束 0.26 秒后就连同启动器一起没了（代理还留着，于是看起来像
 * 「浏览器没了、代理在」，很像我们停了一半）。真正能把窗口留住的只有
 * `scripts/start-all-hold.mjs`（在后台托住），而那是宿主侧的选择，不是本模块能决定的。
 * 所以这句承诺必须带上条件说，否则它就是一句事后查不出原因的假话。
 */
export function releaseAfterBatch({ chainStatus } = {}) {
  if (chainStatus === null || chainStatus === undefined) {
    return { release: true, why: '这一批没跑到链（上一步就失败/被跳过）：没有现场可看，收掉' };
  }
  if (Number(chainStatus) === 0) {
    return { release: true, why: '这一批全绿：按计划收掉，把内存让给下一批' };
  }
  return {
    release: false,
    why: `这一批没跑成（链退出码 ${chainStatus}）—— 不主动释放（失败优先解决问题）；处理完后用 `
      + 'node scripts/stop-all.mjs --yes --only <本批店铺> 释放',
    caveat: '本批的 start 是 scripts/start-all.mjs（起完就退）：宿主要在命令结束时回收整棵进程树，'
      + '所以**这批窗口活不过本轮命令**，「不释放」只是「我不去停它」。'
      + '要让窗口真的留到人来看，得用 scripts/start-all-hold.mjs 在后台把本批实例托住再排查；'
      + '人不在现场时，可查的证据在证据目录里（batches.log ＋ 链自己的体检原始输出）。',
  };
}

/** 日志里那一行「这是第几批、哪几家」。 */
export function describeBatch(batch, total) {
  return `第 ${batch.index}/${total} 批：${batch.shops.join('、')}`;
}

/** 这一批会不会碰到登记表里没有的店铺（开跑前的一道自检；不通过就别起浏览器）。 */
export function assertBatchCoversRegistry(batch) {
  const known = batchableShopKeys();
  const bad = batch.shops.filter((key) => !known.includes(key));
  if (bad.length > 0) throw new Error(`批次里有未登记的店铺：${bad.join('、')}`);
  // 也拒绝「同一家出现两次」：那会让同一家店被两个批次同时驱动（串店的现实版本）。
  const dup = batch.shops.filter((key, i) => batch.shops.indexOf(key) !== i);
  if (dup.length > 0) throw new Error(`批次里同一家店出现多次：${dup.join('、')}`);
  for (const key of batch.shops) shopInstance(key); // 未登记会抛（fail-closed）
  return true;
}
