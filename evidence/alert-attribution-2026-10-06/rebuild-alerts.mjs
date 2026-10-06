// 一次性重建脚本（证据用，不是生产路径）：用**真渲染器 + 本轮真实输入**
// 重建 2026-10-05 那一轮实际发出去的两条飞书告警，并给出修好之后应当长什么样。
//
// 三件事：
//   ① 用本轮真实的体检现场（b1/00-health-check-daily.txt 里那段 JSON）跑 `roundCauseOf`
//      —— 证明「掉登录」这个结论是从真数据里读出来的，不是我在代码里写死的；
//   ② 拿**老 summary**（没有 roundCause 字段）重建一次 ⇒ 必须与当时真发出去的那条逐字相同
//      （「默认不变」这条纪律的证据）；**不一致就非零退出**，别让它变成一段没人看的输出；
//   ③ 拿**加过 roundCause 的 summary** 重建一次 ⇒ 就是修好之后的文案。
//
// 自己向上找仓库根（VERSION + package.json 同时在哪就是哪），在本目录或在 tmp/ 跑都一样。
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

function findRepoRoot(start) {
  let dir = start;
  for (;;) {
    if (fs.existsSync(path.join(dir, 'VERSION')) && fs.existsSync(path.join(dir, 'package.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error('找不到仓库根：一路向上都没有 VERSION + package.json');
    dir = parent;
  }
}

const ROOT = findRepoRoot(import.meta.dirname);
// 动态 import 的 specifier 在 Windows 上必须是 file:// URL；直接给 `D:\...` 会报
// ERR_UNSUPPORTED_ESM_URL_SCHEME —— 也就是说「自己找根」这套写法如果漏了这一步，
// 脚本在本目录根本跑不起来，而它偏偏是**证据脚本**（跑不起来 = 证据不存在）。
const load = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href);

const { renderAlertText } = await load('runtime/notify-feishu-core.mjs');
const { buildLoginAlert } = await load('skills/sycm-alimama-daily-report/scripts/login-merchant-core.mjs');
const { buildRoundFailureAlert, roundCauseOf, roundMissingPagesOf } = await load(
  'skills/sycm-alimama-daily-report/scripts/run-multi-shop-day.mjs');

const DATE = '2026-10-05';
const SHOPS_B1 = ['里可林淘宝', '网林天猫', '盖文淘宝', '盖文天猫', '科塔淘宝'];

const B1 = path.join(ROOT, 'evidence', 'batches-2026-10-05', 'b1');
const rawSummary = JSON.parse(fs.readFileSync(path.join(B1, 'summary.json'), 'utf8'));
const b1Preflight = JSON.parse(fs.readFileSync(
  path.join(ROOT, 'evidence', 'batches-2026-10-05', 'login-preflight-b1.json'), 'utf8'));

// 体检那一步的原始产物里带着完整的 JSON（含 normalize.actions[].from）—— 这就是链在第 0 步
// 手里握着的东西。取第一个 `{` 之后的全部内容当作 JSON。
const healthRaw = fs.readFileSync(path.join(B1, '00-health-check-daily.txt'), 'utf8');
const healthJson = JSON.parse(healthRaw.slice(healthRaw.indexOf('{')));

const derivedCause = roundCauseOf({ ok: healthJson.check.ok, normalize: healthJson.normalize });
const derivedMissing = roundMissingPagesOf(healthJson.normalize);

const loginPreflight = {
  verdict: b1Preflight.verdict,
  needHuman: b1Preflight.needHuman ?? [],
  unknown: b1Preflight.unknown ?? [],
  checked: b1Preflight.checked ?? null,
  unreadable: false,
};

const at = () => new Date('2026-10-06T15:34:56+08:00');
const before = renderAlertText(buildRoundFailureAlert({
  date: DATE, summary: rawSummary, shopKeys: SHOPS_B1, loginPreflight, now: at,
}));

// 加过 roundCause / missingPages 的同一份 summary（就是修好之后链会落盘的样子）
const newSummary = JSON.parse(JSON.stringify(rawSummary));
newSummary.round.healthCheckDaily.roundCause = derivedCause;
newSummary.round.healthCheckDaily.missingPages = derivedMissing;
const after = renderAlertText(buildRoundFailureAlert({
  date: DATE, summary: newSummary, shopKeys: SHOPS_B1, loginPreflight, now: at,
}));

// 当时真发出去的那条（逐字抄自 evidence/batches-2026-10-05/batches.log）
const sentBackThen = [
  '【需要处理】全部店铺的日报都没跑起来（统计日 2026-10-05）',
  '对象：日报一轮 · 5 家店',
  '数据周期：统计日 2026-10-05',
  '任务：各店铺日报',
  '原因：整轮没开跑：那个开着飞书「各店铺日报」的浏览器窗口里，页面不齐。',
  '  目标页面「生意参谋工作页」不在这个浏览器里（按片段 sycm.taobao.com/qos/service/frame/shop/performance 找到 0 个）；采集会从落位那一步就失败。',
  '（跑前先查过登录态：这一轮的店后台都在登录态 —— 所以问题不在登录上，按上面的下一步做。）',
  '下一步：打开那个开着飞书「各店铺日报」的浏览器窗口，把这两页各开一个（只留一个，多开同样会报错）：生意参谋的「店铺」工作页、飞书「各店铺日报」底单页。开好后告诉技术同学重跑一次。',
  '时间：2026-10-06 15:34',
  '告警编号：daily-round-20261005',
].join('\n');

const loginAlert = buildLoginAlert({
  verdict: 'LOGIN_NOT_CONFIRMED',
  detail: '页面还停在登录页 —— 可能是密码不对，也可能是平台要求额外验证。'
    + '系统没有再试一遍（连着试会把账号锁住）。',
  sites: ['sycm'], machine: 'DESKTOP-KJP4RA5',
  browserProfile: 'D:\\Retire\\edge-daily-report-profile', shopName: null,
  now: () => new Date('2026-10-06T15:31:51+08:00'),
});

const out = [
  '# 本轮告警：实际发出去的 vs 修好之后（真渲染器 + 真输入重建）',
  '',
  '重建脚本：`evidence/alert-attribution-2026-10-06/rebuild-alerts.mjs`。',
  '',
  '## 0 从真实体检现场读出来的结论',
  '',
  '输入：`evidence/batches-2026-10-05/b1/00-health-check-daily.txt` 里的 `normalize.actions[].from`',
  '',
  '```json',
  JSON.stringify({
    activeActionFrom: (healthJson.normalize.actions ?? []).map((a) => a.from).filter(Boolean),
    roundCauseOf: derivedCause,
    roundMissingPagesOf: derivedMissing,
  }, null, 2),
  '```',
  '',
  '## 1 当时真发出去的（链的那条）',
  '',
  '```',
  sentBackThen,
  '```',
  '',
  '## 2 拿老 summary 重建 ⇒ 与第 1 节**逐字相同**（证明「不传新字段 = 行为不变」）',
  '',
  '逐字一致：`' + String(before === sentBackThen) + '`',
  '',
  '```',
  before,
  '```',
  '',
  '## 3 修好之后（同一份 summary，多一个 roundCause 字段）',
  '',
  '```',
  after,
  '```',
  '',
  '## 4 登录那条（ensure-merchant-login 发的，alertId sycm-login-sycm-20261006）',
  '',
  '这条不在本轮改动范围内（它的来源是 `login-merchant-core.mjs`），原样附上备查。',
  '注意它仍然渲染了「机器」与「浏览器配置」两行 —— 那是 C 项要处理的东西。',
  '',
  '```',
  renderAlertText(loginAlert),
  '```',
  '',
].join('\n');

const outPath = path.join(ROOT, 'evidence', 'daily-job-2026-10-05', 'ALERT-COPY-REBUILD.md');
fs.writeFileSync(outPath, out, 'utf8');
process.stdout.write(out);
process.stdout.write('\n已落盘：' + outPath + '\n');

// 「默认不变」这条纪律必须是**可判定的**：老 summary 重建出来跟当时发的那条不一致 ⇒ 直接红。
if (before !== sentBackThen) {
  process.stderr.write('\n！！老 summary 的重建结果与当时真发出去的那条不一致 —— '
    + '「不传新字段 = 行为不变」这条已被破坏。\n');
  process.exitCode = 1;
}
