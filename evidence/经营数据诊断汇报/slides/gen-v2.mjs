#!/usr/bin/env node
// 老板版 PPT v2（13 页）的页面生成器：读 tmp/ppt-v2-data.json，写 slides/src/NN.slide。
// 为什么用生成而不是手写：72 个商品名 + 10 行洗手盆 + 12 行店铺，手抄必错；
// 生成后每页仍走 build-slides.mjs（数字/符号包裹）→ lint → upsert，与 v1 同一条链路。
import { readFileSync, writeFileSync, readdirSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const SRC = join(here, 'src');
// 只吃「全 18 天自洽」的数据源；30 天版本已废弃（会把 18 天推广费除以 30 天广告费）
const D = JSON.parse(readFileSync(join(here, '../../../tmp/ppt-v2-data18.json'), 'utf8'));

const NAVY = '#1B3557', RED = '#AE4128', GOLD = '#A97B28', WASH = '#F4F6F8';
const INK = '#15181D', MUT = '#5F6975', LINE = '#DDE2E8', WHITE = '#FFFFFF';
const TOTAL = 13, DATE = '2026-10-20';

const k = (x, d = 0) => Number(x).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
const wan = (x, d = 1) => `${(x / 10000).toFixed(d)}万元`;
const pct = (x, d = 1) => `${Number(x).toFixed(d)}%`;
const trunc = (s, n) => (s.length > n ? `${s.slice(0, n)}…` : s);

const head = (t, sub) => `<Box style={{ height: '96px', flexDirection: 'column', justifyContent: 'center' }}>
            <Text style={{ fontSize: '31px', fontWeight: 700, color: '${NAVY}', lineHeight: 1.25 }}>${t}</Text>${sub ? `
            <Text style={{ fontSize: '15px', color: '${MUT}', lineHeight: 1.4, marginTop: '6px' }}>${sub}</Text>` : ''}
        </Box>`;

const foot = (n) => `<Box style={{ height: '40px', flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
            <Text style={{ fontSize: '13px', color: '${MUT}' }}>经营数据诊断 · ${DATE}</Text>
            <Text style={{ fontSize: '13px', color: '${MUT}' }}>${String(n).padStart(2, '0')} / ${TOTAL}</Text>
        </Box>`;

const slide = (n, body) => `<Slide style={{ width: '1280px', height: '720px', background: '${WHITE}', fontFamily: 'Noto Sans SC', padding: '20px 64px', flexDirection: 'column' }}>
        ${body}
        ${foot(n)}
    </Slide>
`;

/* 手写行：名称列宽 + 若干数值列（Table 不支持列宽，名称长的表改用 flex 行） */
const row = (cells, opt = {}) => {
    const { h = '40px', bg = 'transparent', top = false, boldName = false, nameColor = INK, size = 12.5, width = 0 } = opt;
    const tds = cells.map((c, i) => {
        const w = c.w ?? 120, txt = c.t ?? c;
        const align = c.align ?? (i === 0 ? 'left' : 'right');
        const color = c.color ?? (i === 0 ? nameColor : INK);
        const weight = c.bold ? 700 : (i === 0 && boldName ? 600 : 400);
        return `<Box style={{ width: '${w}px', flexDirection: 'row', justifyContent: '${align === 'right' ? 'flex-end' : align === 'center' ? 'center' : 'flex-start'}', alignItems: 'center' }}>
                <Text style={{ fontSize: '${size}px', color: '${color}', fontWeight: ${weight} }}>${txt}</Text>
            </Box>`;
    }).join('');
    const wStyle = width ? `width: '${width}px', justifyContent: 'space-between', ` : 'gap: \'10px\', ';
    return `<Box style={{ flexDirection: 'row', alignItems: 'center', height: '${h}', ${wStyle}background: '${bg}', borderBottom: '1px solid ${LINE}', ${top ? `borderTop: '2px solid ${NAVY}',` : ''} paddingLeft: '8px', paddingRight: '8px' }}>
            ${tds}
        </Box>`;
};

const tableHead = (cols, h = '38px', width = 0) => row(cols.map((c) => ({ t: c.t, w: c.w, color: WHITE, bold: true })), { h, bg: NAVY, size: 12, width });

/* ============ 01 封面 ============ */
const p01 = slide(1, `<Box style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: '52px' }}>
            <Box style={{ width: '610px', flexDirection: 'column' }}>
                <Box style={{ flexDirection: 'row', alignItems: 'center', gap: '12px', marginBottom: '18px' }}>
                    <Box style={{ width: '36px', height: '3px', background: '${GOLD}' }} />
                    <Text style={{ fontSize: '15px', color: '${GOLD}', fontWeight: 600 }}>经营数据诊断</Text>
                </Box>
                <Text style={{ fontSize: '52px', fontWeight: 700, color: '${NAVY}', lineHeight: 1.22 }}>
                    近 18 天成交 ${wan(D.total.pay)}，<br />问题不在客流，在分配
                </Text>
                <Text style={{ fontSize: '17px', color: '${MUT}', lineHeight: 1.65, marginTop: '24px' }}>
                    这份材料只回答三件事：<br />客人在哪家店、货在哪一步走掉、钱花在哪。<br />每件事都指到具体的店名和商品名。
                </Text>
            </Box>
            <Box style={{ width: '440px', background: '${WASH}', padding: '34px 30px', flexDirection: 'column', gap: '26px' }}>
                <Box style={{ flexDirection: 'column', gap: '6px' }}>
                    <Text style={{ fontSize: '13px', color: '${MUT}' }}>18 天成交</Text>
                    <Text style={{ fontSize: '34px', fontWeight: 700, color: '${NAVY}' }}>${wan(D.total.pay)}</Text>
                </Box>
                <Box style={{ height: '1px', background: '${LINE}' }} />
                <Box style={{ flexDirection: 'column', gap: '6px' }}>
                    <Text style={{ fontSize: '13px', color: '${MUT}' }}>退款</Text>
                    <Text style={{ fontSize: '26px', fontWeight: 700, color: '${RED}' }}>${wan(D.total.refund)}　${pct(D.total.refundRate)}</Text>
                </Box>
                <Box style={{ height: '1px', background: '${LINE}' }} />
                <Box style={{ flexDirection: 'column', gap: '6px' }}>
                    <Text style={{ fontSize: '13px', color: '${MUT}' }}>广告花费 / 带回成交（18 天）</Text>
                    <Text style={{ fontSize: '26px', fontWeight: 700, color: '${NAVY}' }}>${wan(D.ads.cost)}　${wan(D.ads.gmv)}</Text>
                </Box>
            </Box>
        </Box>
        <Box style={{ height: '40px', flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
            <Text style={{ fontSize: '13px', color: '${MUT}' }}>数据区间 ${D.window.from} 至 ${D.window.to}（${D.window.days} 天）　·　${D.usedShops} 家店铺</Text>
            <Text style={{ fontSize: '13px', color: '${MUT}' }}>快照 ${D.meta.snapshotAt}　·　全部指标同一窗口</Text>
        </Box>`);

/* ============ 02 一页看全 ============ */
const blocks = [
    {
        no: '01', t: '客人在哪家店',
        b: `${pct(D.worst4.uv)} 的客人，进了成交最差的 4 家店，只换回 ${pct(D.worst4.pay)} 的销售额。`,
        names: D.worst4.rows.map((r) => r.name).join('、'),
    },
    {
        no: '02', t: '货在哪一步走掉',
        b: `${pct(D.abc.A.nShare)} 的商品做出 ${pct(D.abc.A.payShare)} 的销售额；访客最多的 10 个洗手盆，吃掉 ${pct(D.basinTopSum.uvShareOfProduct)} 的客人，只做 ${pct(D.basinTopSum.payShareOfProduct)} 的成交。`,
        names: '洗手盆 Top 3：盖文人造石立柱盆、科塔挂墙式洗手盆、网林窄边洗漱盆',
    },
    {
        no: '03', t: '钱花在哪',
        b: `${D.zero72.n} 个零成交商品，18 天烧掉 ${wan(D.zero72.cost, 2)}，占推广费 ${pct(D.zero72.shareOfPromo)}。`,
        names: '花钱前三：Nicoline 洞石浴缸、Nicoline 哑光粉浴池、盖文侘寂风立柱盆',
    },
];
const p02 = slide(2, head('三件事，每件都能指到具体的店和货', '这一页看完就知道问题在哪；后面每一页给出名字、数字和动作。') + `
        <Box style={{ height: '540px', flexDirection: 'row', gap: '20px' }}>
            ${blocks.map((x) => `<Box style={{ flex: 1, background: '${WASH}', padding: '26px 22px', flexDirection: 'column' }}>
                <Text style={{ fontSize: '34px', fontWeight: 700, color: '${GOLD}', lineHeight: 1 }}>${x.no}</Text>
                <Text style={{ fontSize: '19px', fontWeight: 700, color: '${NAVY}', marginTop: '14px' }}>${x.t}</Text>
                <Text style={{ fontSize: '15px', color: '${INK}', lineHeight: 1.7, marginTop: '12px' }}>${x.b}</Text>
                <Box style={{ height: '1px', background: '${LINE}', marginTop: '18px', marginBottom: '14px' }} />
                <Text style={{ fontSize: '12.5px', color: '${MUT}', lineHeight: 1.6 }}>${x.names}</Text>
            </Box>`).join('')}
        </Box>`);

/* ============ 03 最差 4 家（名单） ============ */
const shopCols = [{ t: '店铺', w: 196 }, { t: '客人占比', w: 88 }, { t: '销售额占比', w: 96 }, { t: '成交率', w: 80 }];
const shopTable = (rows, total, accent, width) => `${tableHead(shopCols, '38px', width)}
            ${rows.map((r) => row([{ t: r.name, w: 196, color: accent, bold: true }, { t: pct(r.uvShare), w: 88 }, { t: pct(r.payShare), w: 96 }, { t: `${r.cvrX.toFixed(2)}`, w: 80 }], { width })).join('\n            ')}
            ${row([{ t: '合计', w: 196, bold: true }, { t: pct(total.uv), w: 88, bold: true }, { t: pct(total.pay), w: 96, bold: true }, { t: '', w: 80 }], { top: true, bg: WASH, width })}`;

// 极值都从数据算，不手抄
const cvrTop = D.shops[0].cvrX, cvrBottom = D.shops[D.shops.length - 1].cvrX;
const aovSorted = [...D.shops].sort((a, b) => b.aov - a.aov);
const aovTop = aovSorted[0].aov, aovBottom = aovSorted[aovSorted.length - 1].aov;

const p03 = slide(3, head(`${pct(D.worst4.uv)} 的客人，进了这 4 家成交最差的店`, `成交率＝这家店的成交率是 12 家平均的几倍。${cvrBottom.toFixed(2)} 倍＝只有平均水平的五分之一。`) + `
        <Box style={{ height: '540px', flexDirection: 'column' }}>
            <Box style={{ flexDirection: 'row', gap: '44px' }}>
                <Box style={{ width: '560px', flexDirection: 'column' }}>
                    <Text style={{ fontSize: '15px', fontWeight: 700, color: '${RED}', marginBottom: '8px' }}>成交最差的 4 家（吃客人最多、做销售最少）</Text>
                    ${shopTable(D.worst4.rows, D.worst4, RED, 560)}
                </Box>
                <Box style={{ width: '510px', flexDirection: 'column' }}>
                    <Text style={{ fontSize: '15px', fontWeight: 700, color: '${NAVY}', marginBottom: '8px' }}>对照：成交最好的 4 家</Text>
                    ${shopTable(D.best4.rows, D.best4, NAVY, 510)}
                </Box>
            </Box>
            <Box style={{ background: '${WASH}', borderLeft: '4px solid ${GOLD}', padding: '18px 22px', marginTop: '30px' }}>
                <Text style={{ fontSize: '17px', fontWeight: 600, color: '${NAVY}', lineHeight: 1.6 }}>
                    成交率最高 ${cvrTop.toFixed(2)} 倍、最低 ${cvrBottom.toFixed(2)} 倍，相差 ${(cvrTop / cvrBottom).toFixed(0)} 倍；
                    而客单价最高 ${k(Math.round(aovTop))} 元、最低 ${k(Math.round(aovBottom))} 元，只差 ${(aovTop / aovBottom).toFixed(1)} 倍——
                    这 4 家不缺客人，缺的是把客人变成订单的能力。
                </Text>
                <Text style={{ fontSize: '13px', color: '${MUT}', marginTop: '6px' }}>完整 12 家排名见下一页；每家店的每千次成交和客单价都在表里。</Text>
            </Box>
        </Box>`);

/* ============ 04 12 家明细（按成交率排） ============ */
const allCols = [{ t: '店铺', w: 250 }, { t: '成交率（倍）', w: 130 }, { t: '客人占比', w: 116 }, { t: '销售额占比', w: 130 }, { t: '每千次进店成交', w: 156 }, { t: '客单价', w: 110 }];
const worstNames = new Set(D.worst4.rows.map((r) => r.name));
const bestNames = new Set(D.best4.rows.map((r) => r.name));
const p04 = slide(4, head(`12 家店按成交率排：最差 4 家吃掉 ${pct(D.worst4.uv)} 的客人`, '红色＝成交最差 4 家，深蓝＝最好 4 家。每千次进店成交＝每 1000 个访客成交几单。') + `
        <Box style={{ height: '540px', flexDirection: 'column' }}>
            ${tableHead(allCols, '36px', 1152)}
            ${D.shops.map((r) => {
    const isWorst = worstNames.has(r.name), isBest = bestNames.has(r.name);
    return row([
        { t: r.name, w: 250, color: isWorst ? RED : (isBest ? NAVY : INK), bold: isWorst || isBest },
        { t: r.cvrX.toFixed(2), w: 130, color: isWorst ? RED : INK },
        { t: pct(r.uvShare), w: 116 },
        { t: pct(r.payShare), w: 130 },
        { t: `${r.per1000.toFixed(2)} 单`, w: 156 },
        { t: k(Math.round(r.aov)), w: 110 },
    ], { h: '38px', bg: isWorst ? '#FBF2EF' : (isBest ? '#F2F5F9' : 'transparent'), width: 1152 });
}).join('\n            ')}
            <Box style={{ flexDirection: 'row', gap: '28px', marginTop: '18px' }}>
                <Text style={{ fontSize: '12.5px', color: '${MUT}' }}>12 家合计：客人 ${k(D.total.uv)} 人次　成交 ${wan(D.total.pay)}　客单价 ${k(Math.round(D.total.aov))} 元</Text>
                <Text style={{ fontSize: '12.5px', color: '${MUT}' }}>成交率最高的科塔建材卫浴 ${D.shops[0].cvrX.toFixed(2)} 倍，最低的盖文全卫定制 ${D.shops[D.shops.length - 1].cvrX.toFixed(2)} 倍</Text>
            </Box>
        </Box>`);

/* ============ 05 商品主力 ============ */
const p05 = slide(5, head(`${pct(D.abc.A.nShare)} 的主力商品，做出 ${pct(D.abc.A.payShare)} 的销售额`, `${D.product.items} 个在售商品，18 天成交 ${wan(D.product.pay)}。`) + `
        <Box style={{ height: '540px', flexDirection: 'row', gap: '40px' }}>
            <Box style={{ width: '660px', flexDirection: 'column' }}>
                <Text style={{ fontSize: '15px', fontWeight: 700, color: '${NAVY}', marginBottom: '12px' }}>主力 ${D.abc.A.n} 个，按成交额排前 5</Text>
                ${D.mainTop.map((x, i) => `<Box style={{ flexDirection: 'row', alignItems: 'center', height: '76px', borderBottom: '1px solid ${LINE}', gap: '14px' }}>
                    <Text style={{ fontSize: '20px', fontWeight: 700, color: '${GOLD}', width: '30px' }}>${i + 1}</Text>
                    <Box style={{ width: '420px', flexDirection: 'column', gap: '3px' }}>
                        <Text style={{ fontSize: '13px', color: '${INK}', lineHeight: 1.4 }}>${x.nm}</Text>
                        <Text style={{ fontSize: '11.5px', color: '${MUT}' }}>访客 ${k(x.uv)}　支付买家 ${x.buy}</Text>
                    </Box>
                    <Text style={{ fontSize: '20px', fontWeight: 700, color: '${NAVY}', width: '130px', textAlign: 'right' }}>${wan(x.pay)}</Text>
                </Box>`).join('\n                ')}
                <Text style={{ fontSize: '12px', color: '${MUT}', marginTop: '10px' }}>前 5 个合计占商品层成交 ${pct(D.mainTop.reduce((s, x) => s + x.pay, 0) / D.product.pay * 100)}</Text>
            </Box>
            <Box style={{ width: '450px', flexDirection: 'column', gap: '16px' }}>
                <Box style={{ background: '${WASH}', padding: '22px' }}>
                    <Text style={{ fontSize: '13px', color: '${MUT}' }}>补充档 ${D.abc.B.n} 个</Text>
                    <Text style={{ fontSize: '17px', color: '${INK}', marginTop: '6px', lineHeight: 1.6 }}>分走 ${pct(D.abc.B.uvShare)} 的客人，做 ${pct(D.abc.B.payShare)} 的销售额</Text>
                </Box>
                <Box style={{ background: '#FBF2EF', padding: '22px' }}>
                    <Text style={{ fontSize: '13px', color: '${MUT}' }}>长尾档 ${D.abc.C.n} 个</Text>
                    <Text style={{ fontSize: '17px', color: '${INK}', marginTop: '6px', lineHeight: 1.6 }}>分走 ${pct(D.abc.C.uvShare)} 的客人，只做 ${pct(D.abc.C.payShare)} 的销售额</Text>
                    <Text style={{ fontSize: '15px', fontWeight: 700, color: '${RED}', marginTop: '10px' }}>其中 ${D.abc.C.zero} 个 18 天零成交</Text>
                </Box>
                <Box style={{ borderLeft: '4px solid ${GOLD}', paddingLeft: '16px', marginTop: 'auto' }}>
                    <Text style={{ fontSize: '17px', fontWeight: 600, color: '${NAVY}', lineHeight: 1.6 }}>长尾不是没货，<br />是没人管。</Text>
                </Box>
            </Box>
        </Box>`);

/* ============ 06 洗手盆 Top 10 ============ */
const basinCols = [{ t: '商品', w: 620 }, { t: '访客', w: 130 }, { t: '加购率', w: 120 }, { t: '成交（元）', w: 140 }];
const p06 = slide(6, head(`访客最多的 10 个洗手盆，吃掉 ${pct(D.basinTopSum.uvShareOfProduct)} 的客人，只做 ${pct(D.basinTopSum.payShareOfProduct)} 的成交`, `洗手盆全类目 ${D.basin.n} 个商品、${pct(D.basin.uvShare)} 的客人，整体加购率只有 ${D.basin.cartRate.toFixed(2)}%（浴缸 ${D.tub.cartRate.toFixed(2)}%）。`) + `
        <Box style={{ height: '540px', flexDirection: 'column' }}>
            ${tableHead(basinCols, '36px', 1152)}
            ${D.basinTop.map((x) => row([
    { t: x.nm, w: 620, color: x.pay === 0 ? RED : INK, bold: x.pay === 0 },
    { t: k(x.uv), w: 130 },
    { t: pct(x.cartRate, 2), w: 120, color: x.cartRate >= 2 ? GOLD : INK },
    { t: x.pay === 0 ? '0' : k(Math.round(x.pay)), w: 140, color: x.pay === 0 ? RED : INK },
], { h: '39px', bg: x.pay === 0 ? '#FBF2EF' : 'transparent', width: 1152 })).join('\n            ')}
            <Box style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: '14px' }}>
                <Text style={{ fontSize: '12.5px', color: '${MUT}' }}>10 个合计：访客 ${k(D.basinTopSum.uv)}　成交 ${k(Math.round(D.basinTopSum.pay))} 元</Text>
                <Text style={{ fontSize: '12.5px', color: '${MUT}' }}>加购率＝加购人数 ÷ 进店访客</Text>
            </Box>
            <Box style={{ background: '${WASH}', borderLeft: '4px solid ${RED}', padding: '16px 20px', marginTop: '18px' }}>
                <Text style={{ fontSize: '16px', fontWeight: 600, color: '${NAVY}', lineHeight: 1.55 }}>
                    加购率最高的那个（科塔超窄边，5.49%）也是零成交——问题在商品页，不在流量。
                </Text>
            </Box>
        </Box>`);

/* ============ 07 72 个零成交 ============ */
// 序号必须独立成列：写成 `1. Nicoline…` 时，拉丁前缀紧贴中文会被 DSL 整段丢掉（实测）
const zeroCols = [{ t: '#', w: 30 }, { t: '商品', w: 630 }, { t: '花费（元）', w: 140 }, { t: '点击', w: 120 }, { t: '曝光', w: 140 }];
const p07 = slide(7, head(`${D.zero72.n} 个零成交商品，18 天烧掉 ${wan(D.zero72.cost, 2)}`, `占推广总花费 ${pct(D.zero72.shareOfPromo)}。下表是按花费排的前 10 个。`) + `
        <Box style={{ height: '540px', flexDirection: 'column' }}>
            ${tableHead(zeroCols, '36px', 1152)}
            ${D.zero72.list.slice(0, 10).map((x, i) => row([
    { t: String(i + 1), w: 30 },
    { t: x.nm, w: 630 },
    { t: k(x.cost, 0), w: 140, color: RED, bold: true },
    { t: k(x.click), w: 120 },
    { t: k(x.imp), w: 140 },
], { h: '34px', width: 1152 })).join('\n            ')}
            ${row([{ t: '', w: 30 }, { t: `前 10 个合计 ${k(D.zero72.list.slice(0, 10).reduce((s, x) => s + x.cost, 0), 0)} 元`, w: 630, bold: true }, { t: `${k(D.zero72.cost, 0)}`, w: 140, bold: true, color: RED }, { t: k(D.zero72.click), w: 120, bold: true }, { t: '', w: 140 }], { top: true, bg: WASH, width: 1152, h: '38px' })}
            <Box style={{ background: '${WASH}', borderLeft: '4px solid ${GOLD}', padding: '13px 20px', marginTop: '14px' }}>
                <Text style={{ fontSize: '15.5px', fontWeight: 600, color: '${NAVY}', lineHeight: 1.5 }}>
                    ${D.zero72.n} 个合计 ${k(D.zero72.cost, 0)} 元、${k(D.zero72.click)} 次点击，一次成交都没有——这 ${D.zero72.n} 个可以今天停。
                </Text>
                <Text style={{ fontSize: '12px', color: '${MUT}', marginTop: '4px' }}>完整 ${D.zero72.n} 个名单（含商品 ID）见附录 A，可发给推广直接执行。</Text>
            </Box>
        </Box>`);

/* ============ 08 预算错配 ============ */
const starTop4 = D.star13.list.slice(0, 4);
const big = D.star13.big;
const p08 = slide(8, head(`高效组里，${pct(D.star13.top4CostShare)} 的预算做出 ${pct(D.star13.top4GmvShare)} 的成交`, `${D.star13.n} 个高效商品 18 天共花 ${k(D.star13.cost, 0)} 元、带回 ${wan(D.star13.gmv)}。`) + `
        <Box style={{ height: '540px', flexDirection: 'row', gap: '40px' }}>
            <Box style={{ width: '620px', flexDirection: 'column' }}>
                <Text style={{ fontSize: '15px', fontWeight: 700, color: '${NAVY}', marginBottom: '10px' }}>每 1 元推广费换回最多钱的 4 个</Text>
                ${starTop4.map((x, i) => `<Box style={{ flexDirection: 'row', alignItems: 'center', height: '72px', borderBottom: '1px solid ${LINE}', gap: '12px' }}>
                    <Text style={{ fontSize: '18px', fontWeight: 700, color: '${GOLD}', width: '26px' }}>${i + 1}</Text>
                    <Box style={{ width: '400px', flexDirection: 'column', gap: '3px' }}>
                        <Text style={{ fontSize: '12.5px', color: '${INK}', lineHeight: 1.35 }}>${x.nm}</Text>
                        <Text style={{ fontSize: '11.5px', color: '${MUT}' }}>只花了 ${k(x.cost, 0)} 元</Text>
                    </Box>
                    <Text style={{ fontSize: '19px', fontWeight: 700, color: '${NAVY}', width: '150px', textAlign: 'right' }}>每 1 元回 ${x.roas.toFixed(2)} 元</Text>
                </Box>`).join('\n                ')}
                <Text style={{ fontSize: '12.5px', color: '${MUT}', marginTop: '12px' }}>这 4 个加起来只花了 ${k(starTop4.reduce((s, x) => s + x.cost, 0), 0)} 元，占高效组预算 ${pct(D.star13.top4CostShare)}</Text>
            </Box>
            <Box style={{ width: '460px', flexDirection: 'column', gap: '16px' }}>
                <Box style={{ background: '#FBF2EF', padding: '24px' }}>
                    <Text style={{ fontSize: '13px', color: '${MUT}' }}>反面：花得最多的那一个</Text>
                    <Text style={{ fontSize: '13.5px', color: '${INK}', marginTop: '8px', lineHeight: 1.45 }}>${big.nm}</Text>
                    <Box style={{ flexDirection: 'row', alignItems: 'baseline', gap: '10px', marginTop: '12px' }}>
                        <Text style={{ fontSize: '30px', fontWeight: 700, color: '${RED}' }}>${k(big.cost, 0)}</Text>
                        <Text style={{ fontSize: '14px', color: '${MUT}' }}>元，每 1 元只回 ${big.roas.toFixed(2)} 元</Text>
                    </Box>
                    <Text style={{ fontSize: '12.5px', color: '${MUT}', marginTop: '6px' }}>占高效组预算 ${pct(big.costShare)}，只做 ${pct(big.gmvShare)} 的成交</Text>
                </Box>
                <Box style={{ background: '${WASH}', padding: '24px' }}>
                    <Text style={{ fontSize: '13px', color: '${MUT}' }}>把钱挪过来</Text>
                    <Text style={{ fontSize: '16px', color: '${INK}', marginTop: '8px', lineHeight: 1.65 }}>
                        低效组 18 天花了 ${k(D.quad.dog.cost, 0)} 元。砍一半（${k(D.realloc.half, 0)} 元）挪到高效端，
                    </Text>
                    <Text style={{ fontSize: '26px', fontWeight: 700, color: '${NAVY}', marginTop: '10px' }}>静态净增 ${wan(D.realloc.net, 2)}</Text>
                    <Text style={{ fontSize: '12.5px', color: '${MUT}', marginTop: '6px' }}>占商品层成交 ${pct(D.realloc.shareOfProductPay)}，不是预测</Text>
                </Box>
            </Box>
        </Box>`);

/* ============ 09 四个动作 ============ */
const acts = [
    {
        no: '1', t: '止血：停投零成交商品',
        who: `附录 A 的 ${D.zero72.n} 个商品（18 天零成交）`,
        role: '推广运营', when: '今天', ok: `低效花费占比 ${pct(D.quad.dog.costShare)} → ≤40%`,
    },
    {
        no: '2', t: '修商品页：访客最多的 4 个洗手盆',
        who: '盖文立柱盆、科塔挂墙盆、盖文储物立柱盆、科塔超窄边',
        role: '商品运营', when: '两周内', ok: `加购率 ${D.basin.cartRate.toFixed(2)}% → 2.00%`,
    },
    {
        no: '3', t: '挪流量：从最差 4 家店调出来',
        who: D.worst4.rows.map((r) => r.name).join('、'),
        role: '店铺运营', when: '两周内', ok: `每千次进店成交 ${D.funnel.per1000Buy} → 2.0 单`,
    },
    {
        no: '4', t: '并表：销售 2 部 5 家店接进同一张表',
        who: '销售 2 部 5 家店（Paola Lenti 保拉伦蒂、保拉伦蒂旗舰店等）',
        role: '数据负责人 + 销售 2 部', when: '本周内约', ok: '5 家并进同一张表、口径一致',
    },
];
const p09 = slide(9, head('四个动作：今天能做的、两周要做的、需要你点头的', '按顺序来，不要同时全上。每个动作都写清了对象、负责人、时间和验收数。') + `
        <Box style={{ height: '540px', flexDirection: 'column', gap: '12px' }}>
            ${acts.map((a) => `<Box style={{ flexDirection: 'row', background: '${WASH}', height: '118px', alignItems: 'center', paddingLeft: '20px', paddingRight: '20px', gap: '18px' }}>
                <Text style={{ fontSize: '34px', fontWeight: 700, color: '${GOLD}', width: '40px' }}>${a.no}</Text>
                <Box style={{ width: '470px', flexDirection: 'column', gap: '6px' }}>
                    <Text style={{ fontSize: '16px', fontWeight: 700, color: '${NAVY}' }}>${a.t}</Text>
                    <Text style={{ fontSize: '12.5px', color: '${MUT}', lineHeight: 1.5 }}>对象：${a.who}</Text>
                </Box>
                <Box style={{ width: '150px', flexDirection: 'column', gap: '4px' }}>
                    <Text style={{ fontSize: '11.5px', color: '${MUT}' }}>负责人</Text>
                    <Text style={{ fontSize: '13px', color: '${INK}', fontWeight: 600 }}>${a.role}</Text>
                </Box>
                <Box style={{ width: '90px', flexDirection: 'column', gap: '4px' }}>
                    <Text style={{ fontSize: '11.5px', color: '${MUT}' }}>时间</Text>
                    <Text style={{ fontSize: '13px', color: '${INK}', fontWeight: 600 }}>${a.when}</Text>
                </Box>
                <Box style={{ width: '240px', flexDirection: 'column', gap: '4px' }}>
                    <Text style={{ fontSize: '11.5px', color: '${MUT}' }}>验收数</Text>
                    <Text style={{ fontSize: '13px', color: '${RED}', fontWeight: 600 }}>${a.ok}</Text>
                </Box>
            </Box>`).join('\n            ')}
        </Box>`);

/* ============ 10 五个验收数 ============ */
const accCols = [{ t: '指标', w: 300 }, { t: '现在', w: 150 }, { t: '两周后', w: 150 }, { t: '依据 / 怎么动', w: 480 }];
const accs = [
    ['每千次进店成交', `${D.funnel.per1000Buy} 单`, '2.0 单', '把流量从最差 4 家店挪出来'],
    ['洗手盆加购率', `${D.basin.cartRate.toFixed(2)}%`, '2.00%', `补 0.7 个百分点＝多 ${k(D.basinFix.addCart)} 次加购`],
    ['推广每 1 元成交', `${D.promo.roas} 倍`, '4.00 倍', '停掉每 1 元只回 0.10 元那一档'],
    ['低效推广花费占比', pct(D.quad.dog.costShare), '≤40%', `低效预算砍一半（${k(D.realloc.half, 0)} 元）`],
    ['商品层成交（18 天）', wan(D.product.pay), '32 万元', `静态上限 ${wan(D.product.pay + D.realloc.net, 1)}，先按 32 万报`],
];
const p10 = slide(10, head('两周后，用这五个数验收', '这些是提议值，可以改；但必须可量、有期限、有人看。') + `
        <Box style={{ height: '540px', flexDirection: 'column' }}>
            ${tableHead(accCols, '40px', 1152)}
            ${accs.map((a) => row([
    { t: a[0], w: 300, bold: true },
    { t: a[1], w: 150, color: MUT },
    { t: a[2], w: 150, color: RED, bold: true },
    { t: a[3], w: 480, color: MUT },
], { h: '72px', width: 1152 })).join('\n            ')}
            <Box style={{ background: '${WASH}', borderLeft: '4px solid ${GOLD}', padding: '18px 22px', marginTop: '22px' }}>
                <Text style={{ fontSize: '15px', color: '${INK}', lineHeight: 1.6 }}>
                    五个数都在现有报表里能直接读出来，不需要新建口径。两周后拿这五个数对一次，就知道试跑成不成。
                </Text>
            </Box>
        </Box>`);

/* ============ 11 需要你定的三件事 ============ */
const asks = [
    ['批名单', `附录 A 那 ${D.zero72.n} 个零成交商品，今天就停投`, `18 天已经花掉 ${k(D.zero72.cost, 0)} 元，一次成交都没有`],
    ['给许可', '两周试跑，不新增预算', '只动现有的推广预算和店内流量，不额外申请费用'],
    ['给授权', '约销售 2 部，把 5 家店并进同一张表', '并完这一份数据才覆盖 12 家店，口径才算齐'],
];
const p11 = slide(11, head('需要你定的三件事', '定了今天就能开始，不定就还是现在这样。') + `
        <Box style={{ height: '540px', flexDirection: 'column', gap: '18px' }}>
            ${asks.map((a, i) => `<Box style={{ flexDirection: 'row', alignItems: 'center', height: '120px', borderLeft: '5px solid ${i === 0 ? RED : GOLD}', background: '${WASH}', paddingLeft: '24px', paddingRight: '24px', gap: '22px' }}>
                <Text style={{ fontSize: '19px', fontWeight: 700, color: '${i === 0 ? RED : GOLD}', width: '100px' }}>${a[0]}</Text>
                <Box style={{ width: '640px', flexDirection: 'column', gap: '6px' }}>
                    <Text style={{ fontSize: '17px', fontWeight: 600, color: '${NAVY}' }}>${a[1]}</Text>
                    <Text style={{ fontSize: '12.5px', color: '${MUT}' }}>${a[2]}</Text>
                </Box>
            </Box>`).join('\n            ')}
            <Box style={{ marginTop: 'auto', flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-end' }}>
                <Text style={{ fontSize: '16px', color: '${MUT}' }}>两周后拿五个数回来对。</Text>
                <Text style={{ fontSize: '12.5px', color: '${MUT}' }}>数据区间 ${D.window.from} 至 ${D.window.to}　·　${D.usedShops} 家店铺</Text>
            </Box>
        </Box>`);

/* ============ 12 附录 A：72 个清单（两栏全名） ============ */
// 最长商品名 34 字；三栏时名称列只有 250px（≈27 字）必须截断，改两栏后 448px（≈49 字）可全名
const list = D.zero72.list;
const perCol = Math.ceil(list.length / 2);
const cols = [list.slice(0, perCol), list.slice(perCol)];
const p12 = slide(12, head(`附录 A：${D.zero72.n} 个零成交商品（18 天，按花费降序）`, `每行：编号｜完整商品名｜花费｜商品 ID 后 6 位。合计 ${k(D.zero72.cost, 0)} 元、${k(D.zero72.click)} 次点击、0 成交。`) + `
        <Box style={{ height: '540px', flexDirection: 'row', gap: '16px' }}>
            ${cols.map((col, ci) => `<Box style={{ width: '568px', flexDirection: 'column' }}>
                ${col.map((x, i) => `<Box style={{ flexDirection: 'row', alignItems: 'center', height: '14.5px', gap: '4px' }}>
                    <Text style={{ fontSize: '9px', color: '${MUT}', width: '24px' }}>${String(ci * perCol + i + 1).padStart(2, '0')}</Text>
                    <Text style={{ fontSize: '9px', color: '${INK}', width: '448px' }}>${x.nm}</Text>
                    <Text style={{ fontSize: '9px', color: '${RED}', width: '52px', textAlign: 'right' }}>${k(x.cost, 0)}</Text>
                    <Text style={{ fontSize: '8px', color: '${MUT}', width: '44px', textAlign: 'right' }}>${x.id.slice(-6)}</Text>
                </Box>`).join('\n                ')}
            </Box>`).join('\n            ')}
        </Box>`);

/* ============ 13 附录 B：口径 ============ */
const SR = D.meta.sourceRows;
const rowsTotal = SR.daily + SR.product + SR.promo + SR.inquiry;
const p13 = slide(13, head('附录 B：数据从哪来、怎么算的', '这一页只给要复核的人看，汇报时可以不讲。') + `
        <Box style={{ height: '540px', flexDirection: 'row', gap: '44px' }}>
            <Box style={{ width: '520px', flexDirection: 'column' }}>
                <Text style={{ fontSize: '15px', fontWeight: 700, color: '${NAVY}', marginBottom: '12px' }}>数据来源（飞书四张表，只读接口）</Text>
                ${[
        ['店铺日报', `${k(SR.daily)} 行`, '本篇只取 10-01 至 10-18'],
        ['商品日报', `${k(SR.product)} 行`, '10-01 至 10-18，全部覆盖'],
        ['推广日报', `${k(SR.promo)} 行`, '10-01 至 10-18，全部覆盖'],
        ['询单', `${k(SR.inquiry)} 行`, '无日期字段，本篇未使用'],
    ].map((r) => `<Box style={{ flexDirection: 'row', height: '54px', alignItems: 'center', borderBottom: '1px solid ${LINE}' }}>
                    <Text style={{ fontSize: '13px', color: '${INK}', width: '120px', fontWeight: 600 }}>${r[0]}</Text>
                    <Text style={{ fontSize: '13px', color: '${INK}', width: '120px' }}>${r[1]}</Text>
                    <Text style={{ fontSize: '12px', color: '${MUT}', width: '260px' }}>${r[2]}</Text>
                </Box>`).join('\n                ')}
                <Text style={{ fontSize: '12px', color: '${MUT}', marginTop: '14px', lineHeight: 1.6 }}>四张表共 ${k(rowsTotal)} 行。快照日 ${D.meta.snapshotAt}，之后补采的数据不进入本篇。</Text>
            </Box>
            <Box style={{ width: '520px', flexDirection: 'column', gap: '14px' }}>
                <Text style={{ fontSize: '15px', fontWeight: 700, color: '${NAVY}' }}>三条口径，先说清楚</Text>
                ${[
        ['全部指标同一个窗口：18 天', `所有数字都是 ${D.window.from} 至 ${D.window.to}。不用更长的窗口，是因为推广明细表只有这 18 天；拿 18 天的推广费去比更长时间的成交额，会人为把推广占比压低一半以上。`],
        ['广告花费有两个来源，都是 18 天', `日报表的广告花费 ${wan(D.ads.cost)}（关键词 ${wan(D.ads.kw)}＋人群 ${wan(D.ads.au)}）；推广明细表 ${wan(D.promo.cost)}，等于日报口径的 ${pct(D.promo.shareOfDailyAdCost)}。本篇说"推广费"一律指后者。`],
        ['一个商品一个链接', '所有商品数字按商品 ID 汇总，不按名称（同名商品会被错并）；推广按主体 ID 汇总。'],
    ].map((r) => `<Box style={{ background: '${WASH}', padding: '13px 15px' }}>
                    <Text style={{ fontSize: '13px', fontWeight: 700, color: '${NAVY}', marginBottom: '4px' }}>${r[0]}</Text>
                    <Text style={{ fontSize: '11.5px', color: '${INK}', lineHeight: 1.55 }}>${r[1]}</Text>
                </Box>`).join('\n                ')}
            </Box>
        </Box>`);

const pages = [p01, p02, p03, p04, p05, p06, p07, p08, p09, p10, p11, p12, p13];
// 先清掉 v1 的 14/15 页源稿与产物，避免 build 把旧页重新生成
for (const f of readdirSync(SRC).concat(readdirSync(here))) {
    if (/^(1[4-9])\.slide$/u.test(f)) {
        try { unlinkSync(join(SRC, f)); } catch { /* 已在别处 */ }
        try { unlinkSync(join(here, f)); } catch { /* 忽略 */ }
    }
}
pages.forEach((html, i) => writeFileSync(join(SRC, `${String(i + 1).padStart(2, '0')}.slide`), html, 'utf8'));
console.log(`已生成 ${pages.length} 页到 slides/src/`);
