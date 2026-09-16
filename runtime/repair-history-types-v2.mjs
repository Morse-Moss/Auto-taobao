import { PROJECT_PORTS } from './browser-ports.mjs';
// 飞书网页登录态挂在**商家浏览器（乙）**上；端口来自 runtime/browser-ports.mjs。
// 2026-09-16：原先写死的 http://127.0.0.1:3456 是**别的项目**的共享代理 ——
// 那样能不能跑取决于别人的代理是否活着、以及那个浏览器里登的是谁。
const FEISHU_PROXY = `http://127.0.0.1:${PROJECT_PORTS.dailyReportProxy}`;
const t='D4D3F0E3C4C1E962C3E4C8732D8E39CD', p=FEISHU_PROXY, table='tbl7u5CUYiRei7AQ';
const sleep=m=>new Promise(r=>setTimeout(r,m));
async function post(u,b){const r=await fetch(p+u,{method:'POST',body:b});return r.json()}
async function ev(c){const r=await post('/eval?target='+t,c);if(r.error)throw Error(r.error);return r.value}
async function setType(name,opt){
  await post('/clickAt?target='+t,'[data-e2e=bitable-customize-field-btn]'); await sleep(400);
  await ev(`(()=>{const i=document.querySelector('[data-e2e=bitable-field-customize-panel] input');const s=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;s.call(i,${JSON.stringify(name)});i.dispatchEvent(new Event('input',{bubbles:true}));return i.value})()`); await sleep(250);
  const id=JSON.parse(await ev(`JSON.stringify(Object.values(store.getState().bitable.Fields['${table}'].fieldMap).find(f=>f.name===${JSON.stringify(name)})?.id)`));
  await ev(`document.querySelector('.${id} [data-e2e=bitable-field-more-btn]').click();'m'`); await sleep(250);
  await post('/clickAt?target='+t,'li.b-menu__item'); await sleep(450);
  await post('/clickAt?target='+t,'.b-field-type .build-in-field'); await sleep(350);
  const found=await ev(`(()=>{const e=[...document.querySelectorAll('.field-option-text')].find(x=>x.innerText.trim()===${JSON.stringify(opt)});if(!e)return false;e.click();return true})()`);
  if(found!==true&&found!=='true')throw Error('option not found '+name+' '+opt);
  await sleep(250); await ev(`(()=>{const e=[...document.querySelectorAll('.bitable-button-confirm')].at(-1);e.click();return true})()`); await sleep(1000);
}
for(const [name,opt] of [['数据结束日期','日期'],['采集时间','日期'],['价格','数字'],['同款数','数字'],['收藏人数','数字'],['月收货人数计算值','数字'],['月收货金额','数字'],['商品图片','附件'],['是否有效竞品','复选框'],['竞品分类','单选'],['数据状态','单选']]){try{await setType(name,opt);console.log(name,'OK')}catch(e){console.log(name,'ERROR',e.message)}}
await ev('location.reload();"reloading"'); await sleep(10000);
console.log(await ev(`JSON.stringify(Object.values(store.getState().bitable.Fields['${table}'].fieldMap).filter(f=>['数据结束日期','采集时间','价格','同款数','收藏人数','月收货人数计算值','月收货金额','商品图片','是否有效竞品','竞品分类','数据状态','待补数据项'].includes(f.name)).map(f=>({n:f.name,ui:f.fieldUIType,t:f.type})))`));
