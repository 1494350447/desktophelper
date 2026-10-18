import test from "node:test";
import assert from "node:assert/strict";
import { isUsableRegion, rectFromPoints } from "../src/shared/region.ts";

test("two-point selection normalizes either click order", () => {
  assert.deepEqual(rectFromPoints({ x: 120, y: 80 }, { x: 320, y: 280 }), {
    x: 120,
    y: 80,
    width: 200,
    height: 200,
  });
  assert.deepEqual(rectFromPoints({ x: 320, y: 280 }, { x: 120, y: 80 }), {
    x: 120,
    y: 80,
    width: 200,
    height: 200,
  });
});

test("two-point selection rejects tiny regions", () => {
  assert.equal(isUsableRegion({ x: 0, y: 0, width: 5, height: 100 }), false);
  assert.equal(isUsableRegion({ x: 0, y: 0, width: 100, height: 5 }), false);
  assert.equal(isUsableRegion({ x: 0, y: 0, width: 6, height: 6 }), true);
});
