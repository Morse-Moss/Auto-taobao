// 关键词库 base 的**只读** reader 工厂：把「凭据与 base 从哪来」关在一个地方。
//
// 为什么单独一个文件，而不是塞进 `weekly-round-input.mjs`：
// 那个模块的契约是「只算入参、不含任何 I/O 出口」（它有一条源码守卫钉着这一点），
// 好让它能在没有凭据、没有网络的机器上被完整测一遍。凭据来源属于另一件事，分开放。
//
// 为什么复用 `FeishuReader` 而不是再写一个飞书客户端：见 `run-keyword-weekly-local-analysis.mjs`
// 里那个 class 的注释（同一个事实两处实现是本项目吃过亏的老坑）。
import { FeishuReader } from './run-keyword-weekly-local-analysis.mjs';
import { activeProfileName, getProfile, keywordBaseToken, loadFeishuCredentials } from './feishu-targets.mjs';

/**
 * 造一个「懒认证」的只读 reader。
 *
 * 为什么懒：解析器只在**真要跑一轮**时才被调用（声明了 `collectInputResolver` 的排期条目），
 * 而构造 reader 不该在那之前就去换 token —— 一个配置笔误不该表现为一次网络请求。
 */
function lazilyAuthenticated(client) {
  let authentication = null;
  const ensure = () => {
    authentication ??= client.authenticate();
    return authentication;
  };
  return {
    async listTables() {
      await ensure();
      return client.listTables();
    },
    async listRecords(tableId) {
      await ensure();
      return client.listRecords(tableId);
    },
  };
}

/**
 * 返回 `{ profile, appToken, baseUrl, reader }`。
 *
 * `baseUrl` / `appToken` 由 profile 推出来（`feishu-targets.mjs` 是它们的单一事实来源），
 * **不由排期配置手写** —— 手写一份就会与 profile 各自漂移，而「跑的是哪个租户」变成靠记忆判断。
 */
export function createKeywordWeeklyReader({ profile = activeProfileName(), credentials = null } = {}) {
  const credentialsFile = credentials ?? loadFeishuCredentials(profile);
  const appToken = keywordBaseToken(profile);
  const { host } = getProfile(profile);
  return {
    profile,
    appToken,
    baseUrl: `https://${host}/base/${appToken}`,
    reader: lazilyAuthenticated(new FeishuReader({
      appId: credentialsFile.appId,
      appSecret: credentialsFile.appSecret,
      appToken,
    })),
  };
}
