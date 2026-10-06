// 把「修好之后的登录告警」用**真渲染器 + 真构造器**画出来，落成可核对的文本。
//
// 为什么要落成文件：这一批改的就是**收信人看到的那几行字**，而字长什么样只有渲染出来才知道
// （渲染器的白名单会把键名写错的字段静默丢掉，只有渲染成文本才看得见）。
// 运行：node evidence/alert-plain-2026-10-06/rebuild-alert-copy.mjs
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CORE = path.resolve(HERE, '../../skills/sycm-alimama-daily-report/scripts/login-merchant-core.mjs');
const { buildLoginAlert, resolveAction } = await import(`file:///${CORE.replace(/\\/gu, '/')}`);
const { renderAlertText } = await import(`file:///${path
  .resolve(HERE, '../../runtime/notify-feishu-core.mjs').replace(/\\/gu, '/')}`);

const when = () => new Date('2026-10-06T15:31:00+08:00');
const cases = [
  ['共用商家浏览器（没给 --shop，＝定时任务里那一条）', {
    verdict: 'LOGIN_NOT_CONFIRMED',
    detail: '页面还停在登录页 —— 可能是密码不对，也可能是平台要求额外验证。',
    sites: ['sycm'],
  }],
  ['某一家店（给了 --shop，用于对照：那一档本来就是对的）', {
    verdict: 'NO_SAVED_CREDENTIAL',
    detail: '这个窗口的密码库里没有这家店的密码。',
    sites: ['sycm', 'alimama'],
    shopName: '盖文淘宝',
  }],
];

const lines = [
  '# 登录告警：修好之后实际渲染出来的文本（真构造器 + 真渲染器）',
  '',
  '重建脚本：`evidence/alert-plain-2026-10-06/rebuild-alert-copy.mjs`。',
  '改之前的样子逐字保存在 `evidence/daily-job-2026-10-05/ALERT-COPY-REBUILD.md` §4 ——',
  '那一条里有两行 `机器：DESKTOP-KJP4RA5` 与 `浏览器配置：D:\\Retire\\edge-daily-report-profile`，',
  '以及一句没有落点的「登录页已经开在**那台电脑的**浏览器窗口了」。',
  '',
];

for (const [name, input] of cases) {
  lines.push(`## ${name}`, '', '```', renderAlertText(buildLoginAlert({ ...input, now: when })), '```', '');
}

lines.push('## 关键差异（改之前 → 改之后）', '');
lines.push('| | 改之前 | 改之后 |', '| --- | --- | --- |');
lines.push('| 机器名 | `机器：DESKTOP-KJP4RA5` | 不再出现 |');
lines.push('| 浏览器配置 | `浏览器配置：D:\\Retire\\edge-daily-report-profile` | 不再出现（落进回执 `receipt.tech`） |');
lines.push(`| 没给店名时怎么指路 | 「登录页已经开在**那台电脑的**浏览器窗口了」 | 「${
  resolveAction('LOGIN_NOT_CONFIRMED', null).match(/标题写着「.+?」的那个浏览器窗口（任务栏里就能看到）/u)?.[0] ?? '(未取到)'
}」 |`);
lines.push('| 没给店名时的标题 | 「需要你登录一次」（不说哪扇窗） | 点名共用窗口（见上面第 1 例） |');
lines.push('');
lines.push('那条新说法能成立，是因为共用商家浏览器**真的**有标识页了：');
lines.push('`runtime/shop-window-label.mjs --subject merchant` 会把窗口标题写成');
lines.push('`商家浏览器（日报共用） · 日报采集窗口`（由 `scripts/run-daily-job.mjs` 的');
lines.push('`label-merchant-window` 那一步执行；`--no-merchant-label` 可关）。');
lines.push('');

writeFileSync(path.join(HERE, 'ALERT-COPY-AFTER.md'), `${lines.join('\n')}`, 'utf8');
console.log(lines.join('\n'));
