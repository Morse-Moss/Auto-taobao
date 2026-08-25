#!/usr/bin/env node

const PROXY = 'http://127.0.0.1:3456';
const BASE_PREFIX = 'https://rcndesfqro3x.feishu.cn/base/OWebbPUcBa7B8JseYLccQCy9nkf';

async function target() {
  const targets = await fetch(`${PROXY}/targets`).then((response) => response.json());
  const matches = targets.filter((item) => item.type === 'page' && item.url.startsWith(BASE_PREFIX));
  if (matches.length !== 1) throw new Error(`Expected one authorized Feishu target; received ${matches.length}`);
  return matches[0];
}

async function evaluate(targetId, expression) {
  const response = await fetch(`${PROXY}/eval?target=${encodeURIComponent(targetId)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: expression,
  });
  const payload = await response.json();
  if (!response.ok || payload.error) throw new Error(payload.error ?? `Eval failed: ${response.status}`);
  return payload.value;
}

async function click(targetId, selector) {
  const response = await fetch(`${PROXY}/click?target=${encodeURIComponent(targetId)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: selector,
  });
  const payload = await response.json();
  if (!response.ok || payload.error) throw new Error(payload.error ?? `Click failed: ${response.status}`);
}

const visibleSnapshot = String.raw`(() => {
  const visible = (element) => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
  };
  const item = (element) => {
    const rect = element.getBoundingClientRect();
    return {
      tag: element.tagName,
      text: (element.innerText || element.textContent || '').trim().slice(0, 1000),
      role: element.getAttribute('role'),
      e2e: element.getAttribute('data-e2e'),
      selector: element.getAttribute('data-selector'),
      fieldId: element.getAttribute('data-field-id'),
      className: String(element.className || '').slice(0, 220),
      rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
      outer: element.outerHTML.slice(0, 1400),
    };
  };
  const elements = [...document.querySelectorAll('button,input,[role=button],[role=menuitem],[role=option],[role=combobox],[data-field-id]')]
    .filter(visible)
    .map(item)
    .filter((entry) => /(尺寸|字段|查找|引用|关联|多选|保存|确定|取消|文本)/u.test(entry.text));
  return JSON.stringify({ body: (document.body.innerText || '').slice(-16000), elements: elements.slice(-250) }, null, 2);
})()`;

async function main() {
  let page = await target();
  await click(page.targetId, '[data-e2e=bitable-customize-field-btn]');
  await new Promise((resolve) => setTimeout(resolve, 1200));
  page = await target();
  const value = await evaluate(page.targetId, visibleSnapshot);
  console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
