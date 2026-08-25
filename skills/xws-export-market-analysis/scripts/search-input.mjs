export function buildSearchInputExpression(keyword) {
  const value = JSON.stringify(String(keyword));
  return `(() => {
    const input = document.querySelector('#q');
    if (!input) return { ok: false, reason: 'search input missing' };
    input.focus();
    input.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Process' }));
    input.dispatchEvent(new KeyboardEvent('keypress', { bubbles: true, key: 'Process' }));
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, ${value});
    input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: ${value} }));
    input.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'Process' }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: input.value === ${value}, focused: document.activeElement === input };
  })()`;
}
