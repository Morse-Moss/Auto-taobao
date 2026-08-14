import assert from 'node:assert/strict';
import { buildPasteTsv } from '../scripts/build-paste-tsv.mjs';

const csv = '\uFEFF排名,搜索词,搜索人气,点击率,支付转化率\r\n1,普通浴缸,1000,10%-20%,-\r\n2,独立浴缸,900,5%-10%,1%-2%\r\n';
assert.equal(
  buildPasteTsv(csv),
  '1\t普通浴缸\t1000\t10%-20%\t-\r\n2\t独立浴缸\t900\t5%-10%\t1%-2%',
);

assert.throws(
  () => buildPasteTsv('排名,搜索词\r\n1,普通浴缸'),
  /expected exactly five columns/,
);

console.log('paste TSV contract passed');
