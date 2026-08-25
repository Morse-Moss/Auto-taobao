import assert from "node:assert/strict";
import test from "node:test";

import { buildSearchInputExpression } from "../scripts/search-input.mjs";

test("search input expression focuses the field and emits a complete input sequence", () => {
  const expression = buildSearchInputExpression("浴缸");
  assert.match(expression, /input\.focus\(\)/u);
  assert.match(expression, /keydown.*keypress.*input.*keyup.*change/su);
  assert.match(expression, /value === "浴缸"/u);
});
