import fs from 'node:fs';
const x = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
console.log('TARGET', x.target, x.url);
console.log('BODY\n' + x.body);
console.log('CONTROLS');
for (const a of x.controls.filter((a) => a.rect.y > 100)) console.log(JSON.stringify({ tag:a.tag, cls:a.cls, e2e:a.e2e, text:a.text, value:a.value, ce:a.ce, rect:a.rect, outer:a.outer.slice(0,300) }));
console.log('CANDIDATES');
for (const a of x.candidates) console.log(JSON.stringify({ tag:a.tag, cls:a.cls, e2e:a.e2e, text:a.text, rect:a.rect, outer:a.outer.slice(0,500) }));
