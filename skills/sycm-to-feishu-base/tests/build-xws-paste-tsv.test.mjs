import assert from 'node:assert/strict';
import { buildXwsPasteTsv } from '../scripts/build-xws-paste-tsv.mjs';

const csv = [
  '序号,商品图片,商品标题,商品链接,价格,月收货人数,类目,同款数,平台,占位类型,店铺名,店铺旺旺,店铺类型,地址,收藏人数,卖点',
  '1,https://img.example/1.jpg,标题 1,https://item.example/1,612,100+,类目 A,2,淘宝,自然位,店铺 A,旺旺 A,旗舰店,广东 佛山,-,包邮',
  '2,https://img.example/2.jpg,标题 2,https://item.example/2,300 ~ 600,-,类目 B,0,天猫,自然位,店铺 B,旺旺 B,非金牌店铺,河南 商丘,12,',
].join('\n');

const tsv = buildXwsPasteTsv(csv);
assert.equal(tsv.split('\r\n')[0].split('\t')[1], '', 'attachment column must stay blank');

assert.equal(tsv, [
  '1\t\t标题 1\thttps://item.example/1\t612\t100+\t\t\t\t类目 A\t2\t淘宝\t自然位\t店铺 A\t旺旺 A\t旗舰店\t广东 佛山\t-\t包邮',
  '2\t\t标题 2\thttps://item.example/2\t300 ~ 600\t-\t\t\t\t类目 B\t0\t天猫\t自然位\t店铺 B\t旺旺 B\t非金牌店铺\t河南 商丘\t12\t',
].join('\r\n'));

assert.throws(() => buildXwsPasteTsv(csv.replace('月收货人数', '月收货人数错误')), /expected exactly 16 columns/);
assert.throws(() => buildXwsPasteTsv(csv.replace('标题 1', '标题\t1')), /tab or newline/);
console.log('xws paste TSV contract passed');
