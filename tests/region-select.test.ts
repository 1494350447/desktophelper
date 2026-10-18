import test from "node:test";
import assert from "node:assert/strict";
import {
  parsePointerEvent,
  physicalPointToDip,
  regionOnDisplays,
  type DisplayBounds,
} from "../src/main/region-select.ts";

const primary: DisplayBounds = { id: "1", x: 0, y: 0, width: 1920, height: 1080 };
const secondary: DisplayBounds = { id: "2", x: 1920, y: 0, width: 2560, height: 1440 };

test("pointer helper events are parsed without trusting malformed lines", () => {
  assert.deepEqual(parsePointerEvent('{"type":"ready"}'), { type: "ready" });
  assert.deepEqual(parsePointerEvent('{"type":"point","x":12,"y":34}'), { type: "point", x: 12, y: 34 });
  assert.deepEqual(parsePointerEvent('{"type":"done","start":{"x":1,"y":2},"end":{"x":3,"y":4}}'), {
    type: "done",
    start: { x: 1, y: 2 },
    end: { x: 3, y: 4 },
  });
  assert.deepEqual(parsePointerEvent('{"type":"cancel","reason":"escape"}'), { type: "cancel", reason: "escape" });
  assert.equal(parsePointerEvent("not json"), null);
  assert.equal(parsePointerEvent('{"type":"point","x":"12","y":34}'), null);
  assert.equal(parsePointerEvent('{"type":"done","start":{"x":1}}'), null);
});

test("two physical points become a display-relative rectangle", () => {
  assert.deepEqual(regionOnDisplays({ x: 400, y: 300 }, { x: 200, y: 100 }, [primary, secondary]), {
    displayId: "1",
    rect: { x: 200, y: 100, width: 200, height: 200 },
  });
  assert.deepEqual(regionOnDisplays({ x: 2200, y: 300 }, { x: 2000, y: 100 }, [primary, secondary]), {
    displayId: "2",
    rect: { x: 80, y: 100, width: 200, height: 200 },
  });
});

test("a selection spanning displays is clipped to the display with the most overlap", () => {
  assert.deepEqual(regionOnDisplays({ x: 1800, y: 100 }, { x: 2300, y: 400 }, [primary, secondary]), {
    displayId: "2",
    rect: { x: 0, y: 100, width: 380, height: 300 },
  });
  assert.deepEqual(regionOnDisplays({ x: 1700, y: 100 }, { x: 2000, y: 400 }, [primary, secondary]), {
    displayId: "1",
    rect: { x: 1700, y: 100, width: 220, height: 300 },
  });
});

test("a selection entirely outside known displays has no target", () => {
  assert.equal(regionOnDisplays({ x: -500, y: -500 }, { x: -100, y: -100 }, [primary, secondary]), null);
});

test("monitor metadata survives parsing and malformed metadata is dropped", () => {
  const monitor = { x: 0, y: 0, width: 2560, height: 1600, dpi: 144 };
  assert.deepEqual(
    parsePointerEvent(
      '{"type":"done","start":{"x":1,"y":2},"end":{"x":3,"y":4},"monitor":{"x":0,"y":0,"width":2560,"height":1600,"dpi":144}}',
    ),
    { type: "done", start: { x: 1, y: 2 }, end: { x: 3, y: 4 }, monitor },
  );
  assert.deepEqual(
    parsePointerEvent('{"type":"point","x":12,"y":34,"monitor":{"x":0,"y":0,"width":0,"height":1600,"dpi":144}}'),
    { type: "point", x: 12, y: 34 },
  );
});

test("physical pointer pixels map onto DIP display bounds at any scale", () => {
  const monitor = { x: 0, y: 0, width: 2560, height: 1600, dpi: 144 };
  const display = { bounds: { x: 0, y: 0 }, scaleFactor: 1.5 };
  assert.deepEqual(physicalPointToDip({ x: 420, y: 360 }, monitor, display), { x: 280, y: 240 });
  assert.deepEqual(physicalPointToDip({ x: 980, y: 760 }, monitor, display), { x: 980 / 1.5, y: 760 / 1.5 });

  const secondaryMonitor = { x: 2560, y: 0, width: 1920, height: 1080, dpi: 96 };
  const secondaryDisplay = { bounds: { x: 1707, y: 0 }, scaleFactor: 1 };
  assert.deepEqual(physicalPointToDip({ x: 2660, y: 100 }, secondaryMonitor, secondaryDisplay), {
    x: 1807,
    y: 100,
  });
});
