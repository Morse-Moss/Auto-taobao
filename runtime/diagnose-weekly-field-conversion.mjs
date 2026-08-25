import { readFile } from 'node:fs/promises';
import { CompetitorV2FeishuClient } from '../skills/xws-to-feishu-base/scripts/import-competitor-v2.mjs';
const env = Object.fromEntries((await readFile('E:/小红书/.env.local', 'utf8')).split(/\r?\n/u).filter((x) => x && !x.startsWith('#')).map((x) => { const i = x.indexOf('='); return [x.slice(0, i), x.slice(i + 1).replace(/^['"]|['"]$/gu, '')]; }));
const client = new CompetitorV2FeishuClient({ appId: env.FEISHU_APP_ID, appSecret: env.FEISHU_APP_SECRET, appToken: 'OWebbPUcBa7B8JseYLccQCy9nkf' });
await client.authenticate();
const source = (await client.listRecords('tblSS5bxyIeXgngI'))[0];
const values = { 序号: '1', 商品标题: '新品浴缸家用无缝一体亚克力独立式成人酒店民宿小户型欧式浴盆', 商品链接: 'https://item.taobao.com/item.htm?id=675174324950', 价格: 612, 月收货人数: '100+', 类目: '家装主材 >> 浴缸', 同款数: 0, 平台: '淘宝', 占位类型: '自然位', 店铺名: '陈强卫浴工厂店', 店铺旺旺: '强强联合827574885', 店铺类型: '非金牌店铺', 地址: '河南 商丘', 收藏人数: '-', 卖点: '淘金币已抵18元 包邮', 搜索关键词: '浴缸', 商品ID: '675174324950' };
for (const [name, value] of Object.entries(values)) {
  try { await client.batchUpdateRecords('tblSS5bxyIeXgngI', [{ recordId: source.recordId, fields: { [name]: value } }]); console.log('OK', name); }
  catch (error) { console.log('FAIL', name, error.message); }
}
