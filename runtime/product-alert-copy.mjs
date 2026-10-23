// 商品链失败告警的**业务段文案**：缺口 → 「哪几家缺哪一段」—— 纯函数（2026-10-22 抽出）。
//
// 为什么抽出来：用户 2026-10-22 的原话是「告警文案需要更加符合问题，而不是卡在第几步」。
// 上一版业务段是「一句兜底 + 整段缺口原文」，而缺口原文是机读形态：
//     网林天猫/推广 未采集：采集失败：找不到商品数据明细维度选择器
// 收信人（运营）读到的是一句他既看不懂也做不了的话，而真正关心的
// 「哪一天、哪几家、缺哪一段、飞书里少的到底是哪些行」要靠自己去拼。
// 技术段又把 `机读阶段名：inquiry-import` 摆在显眼处 —— 那是内部代号，回答的是「卡在第几步」，
// 不是「缺什么」。所以两段都要换：业务段点名到店，技术段保留代号但配一句人话现象。
//
// 放进 runtime/ 而不是留在 scripts/ 里：这样它有离线用例（`alert-copy.test.mjs` 同一风格），
// 文案改动不必靠真发一条告警来验。

const STAGE_LABELS = Object.freeze({ 底单: '商品底单', 询单: '询单', 推广: '推广' });

/**
 * 把一条缺口拆成 `{ shop, stage, note }`。
 *
 * 认得的形状（`run-product-data-job.mjs` 里 `collectGapOf` / `importOutcomeOf` 的两种输出）：
 *   `网林天猫/推广 未采集：xxx`      → shop=网林天猫 stage=推广 note=xxx
 *   `盖文天猫/询单 导入失败：403 …`  → shop=盖文天猫 stage=询单 note=导入失败：403 …
 *   `推广 批量导入失败（销售1部）…`   → shop=null   stage=null note=原文（整轮/部门级缺口）
 * 拆不出来的**不猜**：原样留给调用方当「另有 N 处」。
 */
export function parseGap(gap) {
  const text = String(gap ?? '').trim();
  const matched = text.match(/^([^\s/]+)\/(底单|询单|推广)\s*(.*)$/u);
  if (!matched) return { shop: null, stage: null, note: text };
  const note = matched[3]
    .replace(/^未采集[:：]?\s*/u, '')
    .replace(/^导入失败[:：]?\s*/u, '导入失败：')
    .trim();
  return { shop: matched[1], stage: matched[2], note };
}

/**
 * 按段分组，输出一句点名：`商品底单 8 家缺（…）；询单 2 家缺（…）`。
 *
 * 段的顺序固定（底单 → 询单 → 推广），与业务上「先有底单再有询单」一致；
 * 空数组返空串（调用方据此退回兜底文案，而不是拼出半句）。
 */
export function describeGapsByStage(gaps = []) {
  const byStage = new Map([['底单', []], ['询单', []], ['推广', []]]);
  let others = 0;
  for (const gap of gaps) {
    const parsed = parseGap(gap);
    if (parsed.stage && parsed.shop) byStage.get(parsed.stage).push(parsed.shop);
    else others += 1;
  }
  const parts = [...byStage.entries()]
    .filter(([, shops]) => shops.length)
    .map(([stage, shops]) => `${STAGE_LABELS[stage]} ${shops.length} 家缺（${shops.join('、')}）`);
  if (others) parts.push(`另有 ${others} 处未完成（整轮/部门级，见技术信息）`);
  return parts.join('；');
}

/**
 * 失败分类的人话。分类是机读码，直接印给收信人等于没翻译 ——
 * 而他正是那个要决定「今天要不要叫个人去点一下」的人。
 */
export function plainFailureClass(klass) {
  switch (String(klass ?? '')) {
    case 'HUMAN_REQUIRED': return '需要人去浏览器里处理（多半是登录或验证码）';
    case 'TRANSIENT_EXTERNAL': return '平台侧间歇性失败，脚本已按规则重试过，通常重跑一次就能补上';
    case 'UNKNOWN_WRITE': return '写入结果不确定（可能已经写进去了），需要先核对飞书再决定要不要重跑';
    case 'RECOVERED': return '中途失败过、后来自己恢复了';
    case 'FAILED': return '采集或导入没有完成，脚本没能自动修好';
    default: return '脚本没能自动修好，需要技术同学看现场';
  }
}

/**
 * 动作段：按分类给下一步。
 *
 * 「这一轮不需要你在浏览器里做什么」这句话**只在确定不用人动手时**才出现 ——
 * HUMAN_REQUIRED 时人恰恰得去点一下，那句安慰会把他拦住。
 */
export function describeNextAction(klass) {
  if (String(klass ?? '') === 'HUMAN_REQUIRED') {
    return '需要有人在对应店铺的浏览器窗口里完成登录或验证码，完成后重跑这一天的采集即可。';
  }
  return '这一轮不需要你在浏览器里做什么。如果到今天下班前飞书里还是缺这一天的商品数据，'
    + '就把这条消息转给技术同学，让他去看。';
}

/** 逐店现象（给技术段的那一句，压到 240 字）。没有逐店缺口时返空串。 */
export function describePhenomena(gaps = [], limit = 240) {
  const rows = (gaps ?? []).map((gap) => String(gap).replace(/\s+/gu, ' ').trim()).filter(Boolean);
  if (!rows.length) return '';
  const text = `逐店现象：${rows.join('；')}`;
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}
