#!/usr/bin/env node
const target = process.argv[2];
const expression = process.argv.slice(3).join(' ');
const r = await fetch(`http://127.0.0.1:3456/eval?target=${encodeURIComponent(target)}`, { method: 'POST', body: expression });
console.log((await r.json()).value);
