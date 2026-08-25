import fs from 'node:fs';
const outer = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const value = typeof outer.value === 'string' ? JSON.parse(outer.value) : outer.value;
for (const item of value.filter((x) => x.text && x.text.length < 600)) {
  console.log(JSON.stringify({ tag: item.tag, cls: item.cls, role: item.role, e2e: item.e2e, selector: item.selector, text: item.text, rect: item.rect }, null, 2));
}
