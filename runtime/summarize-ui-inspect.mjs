import fs from 'node:fs';
const file = process.argv[2];
const outer = JSON.parse(fs.readFileSync(file, 'utf8'));
const value = typeof outer.value === 'string' ? JSON.parse(outer.value) : outer.value;
console.log('bodyTail', value.body.slice(-4000));
console.log('exactNames', Object.entries(value.exact).filter(([, items]) => items.length).map(([name]) => name));
console.log('largeOverlay', value.overlay.filter((item) => item.rect?.w > 200 && item.rect?.h > 100).map(({ tag, cls, e2e, selector, text, rect }) => ({ tag, cls, e2e, selector, text, rect })));
console.log('candidateControls', value.controls.filter((item) => /field|custom|ai|prompt|生成|保存|材质|外形|安装|功能|风格|尺寸|空间/i.test(`${item.e2e ?? ''} ${item.cls ?? ''} ${item.text ?? ''} ${item.title ?? ''}`)).slice(-200));
