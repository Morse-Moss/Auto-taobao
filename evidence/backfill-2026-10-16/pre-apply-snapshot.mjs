// 写入前快照：把推广底单当前全量 record_id 落盘，供写入后逐条对账
// （独立回读的一部分：不信任导入器自己报的 afterRows）
import { writeFileSync } from 'node:fs';
import { loadFeishuCredentials } from '../../runtime/feishu-targets.mjs';
import { FeishuClient } from '../../skills/xws-to-feishu-base/scripts/feishu-client.mjs';

const c = loadFeishuCredentials('kcne');
const client = new FeishuClient({
  appId: c.appId,
  appSecret: c.appSecret,
  appToken: 'FhCUbn7vVaEc26sRjMAccQJAn5e',
  tableId: 'tblC6QPcGOQu1D0T',
});
const rs = await client.listRecords();
writeFileSync(
  new URL('./pre-apply-snapshot.json', import.meta.url),
  JSON.stringify({ at: new Date().toISOString(), count: rs.length, recordIds: rs.map((r) => r.record_id) }, null, 1),
);
console.log('pre-apply rows:', rs.length);
