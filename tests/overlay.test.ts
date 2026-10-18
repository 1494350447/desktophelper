import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { overlayDragBounds, overlayHitZone } from "../src/shared/overlay.ts";

const bounds = { x: 100, y: 200, width: 560, height: 720 };

test("dragging only moves the overlay and keeps its size", () => {
  assert.deepEqual(overlayDragBounds(bounds, 80, 40), {
    x: 180,
    y: 240,
    width: 560,
    height: 720,
  });
  assert.deepEqual(overlayDragBounds(bounds, -35, -12), {
    x: 65,
    y: 188,
    width: 560,
    height: 720,
  });
});

test("repeated drag steps never accumulate size drift", () => {
  let current = { ...bounds };
  for (let step = 0; step < 60; step += 1) {
    current = overlayDragBounds(current, 1, 1);
  }
  assert.deepEqual(current, { x: 160, y: 260, width: 560, height: 720 });
});

test("drag helpers tolerate missing or non-finite offsets", () => {
  assert.deepEqual(overlayDragBounds(bounds), bounds);
  const moved = overlayDragBounds(bounds, Number.NaN, Number.POSITIVE_INFINITY);
  assert.deepEqual(moved, bounds);
});

test("points outside the overlay never wake the window", () => {
  assert.deepEqual(overlayHitZone({ x: 50, y: 200 }, bounds), {
    inside: false,
    drag: false,
    resize: false,
    control: false,
  });
  assert.deepEqual(overlayHitZone({ x: 100, y: 921 }, bounds), {
    inside: false,
    drag: false,
    resize: false,
    control: false,
  });
});

test("the title band is draggable without being a resize edge", () => {
  const zone = overlayHitZone({ x: 400, y: 210 }, bounds);
  assert.equal(zone.inside, true);
  assert.equal(zone.drag, true);
  assert.equal(zone.resize, false);
});

test("middle content stays click-through", () => {
  const zone = overlayHitZone({ x: 380, y: 560 }, bounds);
  assert.equal(zone.inside, true);
  assert.equal(zone.drag, false);
  assert.equal(zone.resize, false);
  assert.equal(zone.control, false);
});

test("reported control regions wake the window for clicks", () => {
  const zone = overlayHitZone({ x: 380, y: 560 }, bounds, {
    regions: [{ x: 250, y: 330, width: 120, height: 40 }],
  });
  assert.equal(zone.inside, true);
  assert.equal(zone.control, true);
  const miss = overlayHitZone({ x: 150, y: 560 }, bounds, {
    regions: [{ x: 250, y: 330, width: 120, height: 40 }],
  });
  assert.equal(miss.control, false);
});

test("window edges and the bottom-right grip wake resizing", () => {
  assert.equal(overlayHitZone({ x: 104, y: 560 }, bounds).resize, true);
  assert.equal(overlayHitZone({ x: 656, y: 560 }, bounds).resize, true);
  assert.equal(overlayHitZone({ x: 380, y: 916 }, bounds).resize, true);
  const corner = overlayHitZone({ x: 648, y: 908 }, bounds);
  assert.equal(corner.resize, true);
  assert.equal(corner.drag, false);
});

test("custom bands are respected", () => {
  const zone = overlayHitZone({ x: 105, y: 560 }, bounds, { resizeBand: 4 });
  assert.equal(zone.resize, false);
});

test("the title bar relies on native window dragging", () => {
  const css = readFileSync(new URL("../src/renderer/styles.css", import.meta.url), "utf8");
  const renderer = readFileSync(new URL("../src/renderer/renderer.ts", import.meta.url), "utf8");
  const start = css.indexOf(".titlebar {");
  const block = css.slice(start, css.indexOf("}", start));
  assert.match(block, /-webkit-app-region:\s*drag/);
  assert.equal(renderer.includes("bindWindowDrag"), false);
  assert.equal(renderer.includes("overlay.drag"), false);
});

test("the overlay is non-activating and is shown without focus", () => {
  const main = readFileSync(new URL("../src/main/index.ts", import.meta.url), "utf8");
  const createStart = main.indexOf("function createOverlayWindow");
  assert.ok(createStart >= 0, "createOverlayWindow missing");
  const createBlock = main.slice(createStart, main.indexOf("function persistBounds", createStart));
  assert.match(createBlock, /focusable:\s*false/);
  assert.match(createBlock, /win\.setFocusable\(false\)/);
  assert.match(createBlock, /skipTaskbar:\s*true/);
  assert.match(createBlock, /type:\s*process\.platform === "win32" \? "toolbar"/);
  assert.match(createBlock, /win\.setSkipTaskbar\(true\)/);
  assert.doesNotMatch(createBlock, /setSkipTaskbar\(false\)/);

  const showStart = main.indexOf("function showOverlay");
  assert.ok(showStart >= 0, "showOverlay missing");
  const showBlock = main.slice(showStart, main.indexOf("function setOverlayKeyboard", showStart));
  assert.match(showBlock, /win\.showInactive\(\)/);
  assert.doesNotMatch(showBlock, /win\.focus\(\)/);
  assert.match(showBlock, /win\.setSkipTaskbar\(true\)/);
  assert.doesNotMatch(showBlock, /setSkipTaskbar\(false\)/);
});

test("ordinary overlay clicks do not request keyboard activation", () => {
  const renderer = readFileSync(new URL("../src/renderer/renderer.ts", import.meta.url), "utf8");
  const start = renderer.indexOf("function activateInteraction");
  assert.ok(start >= 0, "activateInteraction missing");
  const block = renderer.slice(start, renderer.indexOf("function releaseInteraction", start));
  assert.doesNotMatch(block, /overlay\.interaction/);
  assert.doesNotMatch(block, /overlay\.keyboard/);
});
