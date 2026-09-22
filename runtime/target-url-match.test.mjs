// 「页签属于哪个目标页面」判据的用例（2026-09-22 建）。
//
// 第一条不是「补充测试」，而是**把两次现场事故钉住**：
//   2026-09-17  evidence/rerun-2026-09-17/health/00-health-check-daily.txt
//   2026-09-22  evidence/multi-shop-2026-09-21-rerun6/00-health-check-daily.txt
// 两次都是同一个码 `TARGET_PAGE_AMBIGUOUS`、同一个目标页「生意参谋工作页」，成因也一样：
// 生意参谋的**登录跳转页**把目标地址放在查询参数 `_target=` 里，而旧判据是「整串 URL includes 片段」
// ⇒ 跳转页被算成工作页 ⇒ 找到 2 个 ⇒ 体检阻断 ⇒ `resolveTarget` 抛 `expected one … got 2`
// ⇒ **整轮日报一步都不跑**。所以这里逐条把「什么算命中、什么不算」摆出来。
import test from 'node:test';
import assert from 'node:assert/strict';

import { hostMatches, hostOfUrl, pagesMatching, parseUrl, urlMatchesFragment } from './target-url-match.mjs';

const SYCM = 'sycm.taobao.com/qos/service/frame/shop/performance';
const ALI = 'one.alimama.com';
const FEISHU = 'feishu.cn/base/PTfHbPt9EaIzddsfL8Jcj238nrb';

test('回归：生意参谋的登录跳转页不算命中工作页（09-17 与 09-22 两次停线的成因）', () => {
  const loginJump = 'https://sycm.taobao.com/custom/login.htm'
    + '?_target=http://sycm.taobao.com/qos/service/frame/shop/performance/new#/shop';
  assert.equal(urlMatchesFragment(loginJump, SYCM), false,
    '目标地址在查询参数里，整串包含不等于命中；算命中就会让体检报「工作页不唯一」、整轮不开跑');
  assert.equal(urlMatchesFragment(loginJump, SYCM) === false
    && urlMatchesFragment('https://sycm.taobao.com/qos/service/frame/shop/performance/new#/shop', SYCM) === true,
  true, '真工作页必须仍然命中（否则就从「多认」翻到「认不出」）');
});

test('回归：商家浏览器里「一个登录跳转页 + 一个真工作页」只算 1 个命中', () => {
  const targets = [
    { type: 'page', url: `https://sycm.taobao.com/custom/login.htm?_target=http://${SYCM}/new#/shop` },
    { type: 'page', url: `https://${SYCM}/new#/shop` },
  ];
  assert.equal(pagesMatching(targets, SYCM).length, 1);
});

test('各站点的命中口径', () => {
  const cases = [
    ['https://sycm.taobao.com/qos/service/frame/shop/performance/new#/shop', SYCM, true, '真工作页'],
    ['https://sycm.taobao.com/portal/home.htm', SYCM, false, '生意参谋门户首页不是工作页'],
    [`https://sycm.taobao.com/custom/user_info?_target=${SYCM}`, SYCM, false, '带 _target 的其它跳转页'],
    ['https://one.alimama.com/index.html', ALI, true, '阿里妈妈首页'],
    ['https://one.alimama.com/index.html#!/report/download-list', ALI, true, '阿里妈妈报表页（hash 路由）'],
    ['https://sycm.taobao.com/index.html', ALI, false, '别的站点不命中阿里妈妈'],
    [`https://kcne618basvj.feishu.cn/base/PTfHbPt9EaIzddsfL8Jcj238nrb?table=t&view=v`, FEISHU, true, '飞书底单页（子域名）'],
    ['https://accounts.feishu.cn/accounts/page/login', FEISHU, false, '飞书登录页不在同一主机路径上'],
    ['https://kcne618basvj.feishu.cn/base/别的一个base', FEISHU, false, '同一 base 主机但不同 base token'],
  ];
  for (const [url, fragment, want, why] of cases) {
    assert.equal(urlMatchesFragment(url, fragment), want, why);
  }
});

test('认不出来的 URL 永远不命中（about:blank / devtools 不是「漂走的那一页」）', () => {
  for (const url of ['about:blank', 'devtools://devtools/bundled/inspector.html', '', null, undefined]) {
    assert.equal(urlMatchesFragment(url, SYCM), false, String(url));
  }
  assert.equal(urlMatchesFragment('https://sycm.taobao.com/qos/service/frame/shop/performance/new', ''), false);
  assert.equal(urlMatchesFragment('https://sycm.taobao.com/qos/service/frame/shop/performance/new', null), false);
});

test('主机匹配允许子域，但不允许别的域', () => {
  assert.equal(hostMatches('kcne618basvj.feishu.cn', 'feishu.cn'), true);
  assert.equal(hostMatches('feishu.cn', 'feishu.cn'), true);
  assert.equal(hostMatches('evil-feishu.cn', 'feishu.cn'), false, '不能靠后缀字符蒙对');
  assert.equal(hostMatches('feishu.cn.attacker.com', 'feishu.cn'), false);
  assert.equal(hostMatches('', 'feishu.cn'), false);
  assert.equal(hostMatches('a.feishu.cn', ''), false);
});

test('hostOfUrl：协议+主机小写，认不出返回 null（shop-pages 的漂移判定依赖这条）', () => {
  assert.equal(hostOfUrl('https://Sycm.Taobao.COM/qos/x'), 'https://sycm.taobao.com');
  assert.equal(hostOfUrl('http://127.0.0.1:19023/targets'), 'http://127.0.0.1:19023');
  assert.equal(hostOfUrl('about:blank'), null);
  // devtools:// 这种「有协议+主机」的，正则认为格式合法 ⇒ 会返回 'devtools://devtools'。
  // 真正要守的性质是「它当不上候选」，所以这里断言的是**与期望站点不相等**，而不是「返回 null」。
  assert.equal(hostOfUrl('devtools://devtools/bundled/inspector.html'), 'devtools://devtools');
  assert.notEqual(hostOfUrl('devtools://devtools/bundled/inspector.html'), 'https://sycm.taobao.com');
  assert.equal(hostOfUrl(undefined), null);
});

test('parseUrl 只暴露参与匹配的两要素（query/hash 不参与）', () => {
  const parsed = parseUrl('https://sycm.taobao.com/custom/login.htm?_target=AAA#BBB');
  assert.deepEqual(parsed, { hostname: 'sycm.taobao.com', pathname: '/custom/login.htm' });
  // about:blank 在 Node 里是合法 URL（非特殊协议）⇒ 不返回 null，而是空 hostname。
  // 它不命中期望页面靠的是「主机不匹配」，不是「解析失败」。
  assert.deepEqual(parseUrl('about:blank'), { hostname: '', pathname: 'blank' });
  assert.equal(urlMatchesFragment('about:blank', SYCM), false, '主机为空 ⇒ 不命中');
});

test('片段里带 query/hash 时，那部分不参与匹配（文件头写明的边界）', () => {
  // 这条是「说明书用例」：它把已知的边界用断言摆出来，而不是留给下一个人去猜。
  assert.equal(urlMatchesFragment(`https://${SYCM}/new#/shop`, `${SYCM}?a=1#b`), true);
});
