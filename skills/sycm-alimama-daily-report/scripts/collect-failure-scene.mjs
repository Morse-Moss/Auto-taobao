/**
 * 叶子采集脚本的「失败现场」出口（2026-10-13 加，待修清单 ㊶ 的落地）。
 *
 * 要补的缺口是什么：整轮日报跑的时候，编排层 `run-multi-shop-day.mjs` 会在任何一步失败后
 * 采一次现场（`captureFailureState`）。但**单独跑一个采集脚本**时（手工补跑、一次性排查、
 * 商品链自己那一轮），失败只留下一句符号 —— 比如 `30000ms 内没等到新 zip`。
 * 符号不说明页面当时长什么样，于是判因只能靠人肉复现：这正是「每天要跑通都得对话好几轮」
 * 的成本来源，也正是缺陷⑤（网林 promotion-fetch）到今天还定不了根因的原因之一。
 *
 * 分工：本模块只做「把那三个代理调用接上」，采什么、怎么落盘全在 `failure-perception.mjs`
 * （感知层的三条纪律照旧：永不抛、感知失败也留痕、纯函数 + 依赖注入）。
 * 这里**不写第二套现场表达式**，也不写第二套「哪个页签算哪一页」——
 * 后者由调用方给 `pageHint`，感知层拿 `runtime/target-url-match.mjs` 判。
 *
 * 为什么是「给了 --log-dir 才采」而不是无条件采：
 *   整轮跑时编排层已经采过了，叶子再采一遍＝同一件事做两遍（多几次 /targets、/eval、截图），
 *   而且两个产物目录不同，读的人要先判断该看哪一份。所以默认不采，只在单独跑时显式开。
 *   ⚠️ 不采的那一档会**打印一句**说明为什么不采 —— 静默跳过会让「没现场」与「不需要现场」
 *   长得一样，那是本项目反复吃过的那类亏。
 */
import { captureFailureState } from './failure-perception.mjs';

/**
 * 采一次失败现场。**永不抛**（连它自己出错都只记一句话，绝不让它盖掉主线失败原因）。
 *
 * @param {object} o
 * @param {string} o.proxy     该店 CDP 代理基址（如 http://127.0.0.1:19041）
 * @param {string|null} o.logDir 产物目录。**空 ⇒ 不采**（理由见文件头）。
 * @param {string} o.stage     阶段名（进人读版与 JSON）
 * @param {string|null} [o.pageHint] 站点标签（`alimama` / `sycm`）——该拍哪一站的页
 * @param {string} o.error     主线失败原因（只记录，不改写）
 * @param {string|null} [o.shopKey]
 * @param {Function} [o.log]
 * @returns {Promise<object|null>} 感知层的返回；没采时返回 null
 */
export async function captureCollectorFailureScene({
  proxy, logDir, stage, pageHint = null, error, shopKey = null, log = console.log,
} = {}) {
  if (!logDir) {
    log('[失败现场] 没给 --log-dir ⇒ 本轮不采（整轮跑时由编排层统一采，这里不重复拍一遍）');
    return null;
  }
  try {
    return await captureFailureState({
      proxy, logDir, shopKey, stage, error, pageHint,
      readTargets: async (base) => {
        const response = await fetch(`${base}/targets`);
        const text = await response.text();
        if (!response.ok) throw new Error(`/targets HTTP ${response.status} ${text.slice(0, 120)}`);
        return JSON.parse(text);
      },
      // 形状必须与代理真会的一致：`/eval` 回 `{ value: <表达式返回值> }`。
      // 感知层的 `unwrapEvalValue` 负责剥这层，这里只要把原始响应体交上去。
      evalInPage: async (base, targetId, expression) => {
        const response = await fetch(`${base}/eval?target=${encodeURIComponent(targetId)}`,
          { method: 'POST', body: expression });
        const text = await response.text();
        if (!response.ok) throw new Error(`/eval HTTP ${response.status} ${text.slice(0, 120)}`);
        return JSON.parse(text);
      },
      // 截图失败只降级（感知层自己会记进 errors），不该让整份现场跟着丢。
      screenshot: async (base, targetId, file) => {
        const response = await fetch(`${base}/screenshot?target=${encodeURIComponent(targetId)}`
          + `&file=${encodeURIComponent(file)}`);
        if (!response.ok) throw new Error(`/screenshot HTTP ${response.status}`);
        return file;
      },
      log,
    });
  } catch (perceptionError) {
    // 感知层本来就承诺永不抛；这一层是兜它自己（例如 log 抛了 —— stdout 管道被关时
    // `console.log` 真的会抛 EPIPE，那不是假想）。记住立场：
    // **感知失败是「学不到」，不是「又出错了」** —— 绝不盖掉主线失败原因。
    try {
      log(`[失败现场] 采集本身出错（不影响上面的失败原因）：`
        + `${String(perceptionError?.message ?? perceptionError)}`);
    } catch {
      // 日志自己坏了也不许冒出去：这一层存在的意义就是「任何情况下都不改变主线行为」。
    }
    return null;
  }
}
