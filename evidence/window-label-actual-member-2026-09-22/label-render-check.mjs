// 渲染级证明：把窗口标签页**真的在一个浏览器里渲染一遍**，回读 DOM，看那一行到底长什么样。
//
// 为什么必须做：源码级判据（正则匹配 HTML 文本）只能证明「代码写在那儿」，证明不了
// 「页面跑起来真的画出来了」—— 而「契约齐、测试绿、接线没接上」正是本仓库反复吃过的形态。
//
// 只用一次性 headless 实例：临时 profile（ASCII 路径）、**不碰任何运行中的实例**、
// 不开调试端口、跑完即退。URL 一律用 labelPageUrlFor 生成 —— 与 CLI 会写进标签页的那个逐字同源。
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { labelPageUrlFor } from '../../runtime/shop-window-label.mjs';

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PROFILE = 'D:/Retire/sycm-automation/tmp/edge-headless-profile';
mkdirSync(PROFILE, { recursive: true });

const dump = (url) => {
  const res = spawnSync(EDGE, [
    '--headless=new', `--user-data-dir=${PROFILE}`, '--no-first-run', '--no-default-browser-check',
    '--disable-sync', '--disable-extensions', '--virtual-time-budget=3000', '--dump-dom', url,
  ], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  const dom = res.stdout ?? '';
  if (!dom.includes('id="actual"')) {
    throw new Error(`拿不到 DOM（exit=${res.status}）：${(res.stderr ?? '').slice(0, 300)}`);
  }
  // 把相关的那几行摘出来，别把 1000 行 DOM 全倒出来
  const pick = (id) => new RegExp(`<div[^>]*id="${id}"[^>]*>[^<]*</div>`, 'u').exec(dom)?.[0] ?? '(没有这个元素)';
  return { shop: pick('shop'), member: pick('member'), actual: pick('actual'), state: pick('state') };
};

const CASES = [
  { name: '一致（与登记表相同）', args: { shop: '盖文淘宝', port: 19033, member: '随心品质定制:阿彦', actual: '随心品质定制:阿彦' }, want: ['实际登录 随心品质定制:阿彦', '与登记表一致', 'x ok'] },
  { name: '不一致（串号的现场）', args: { shop: '盖文淘宝', port: 19033, member: '随心品质定制:阿彦', actual: 'j873522735:阿彦' }, want: ['实际登录 j873522735:阿彦', '不一致', 'x bad'] },
  { name: '登记表里没有期望值（只报实际值）', args: { shop: '保拉淘宝', port: 19099, actual: 'somebody:阿彦' }, want: ['实际登录 somebody:阿彦', '没有这家的期望值'] },
  { name: '没量到（整行不显示）', args: { shop: '盖文淘宝', port: 19033, member: '随心品质定制:阿彦' }, want: [] },
];

let bad = 0;
for (const c of CASES) {
  const url = labelPageUrlFor(c.args);
  const dom = dump(url);
  const line = dom.actual;
  const misses = c.want.filter((w) => !line.includes(w));
  const emptyWhenShouldBe = c.want.length === 0 && line !== '<div class="x" id="actual"></div>';
  if (misses.length > 0 || emptyWhenShouldBe) bad += 1;
  console.log(`${misses.length === 0 && !emptyWhenShouldBe ? 'PASS' : 'FAIL'}  ${c.name}`);
  console.log(`      页面渲染 = ${line}`);
  if (misses.length > 0) console.log(`      缺：${misses.join(' / ')}`);
  if (emptyWhenShouldBe) console.log('      本该整行不显示（空的 div），实际却有内容');
  // 顺带把「登记表那一行」也打出来，证明两行是并列的、人一眼能对上
  if (c.name === '不一致（串号的现场）') console.log(`      对照：${dom.member}`);
}

// 顺带证明：URL 里出现的是账号名，不是别的
const sample = labelPageUrlFor({ shop: '科塔淘宝', port: 19034, member: 'j873522735:阿彦', actual: 'j873522735:阿彦' });
console.log(`\n样例 URL 的键：${[...new URL(sample).searchParams.keys()].join(', ')}`);
console.log(`样例 URL：${sample}`);
process.exit(bad === 0 ? 0 : 1);
