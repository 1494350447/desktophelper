import test from "node:test";
import assert from "node:assert/strict";
import {
  HOTKEY_DEFINITIONS,
  HOTKEY_GROUPS,
  acceleratorFromKeyboard,
  defaultHotkeys,
  formatAccelerator,
  normalizeAccelerator,
  normalizeHotkeySettings,
  toGlobalAccelerator,
  visibleHotkeyDefinitions,
} from "../src/shared/hotkeys.ts";

test("default hotkeys are complete and use unique accelerators", () => {
  const defaults = defaultHotkeys();
  const ids = HOTKEY_DEFINITIONS.map((definition) => definition.id);

  assert.equal(new Set(ids).size, ids.length);
  for (const definition of HOTKEY_DEFINITIONS) {
    assert.equal(defaults[definition.id], definition.accelerator);
  }

  const accelerators = Object.values(defaults).map((value) => value.toLowerCase());
  assert.equal(new Set(accelerators).size, accelerators.length);
});

test("every visible hotkey belongs to a declared settings group", () => {
  const groups = new Set(HOTKEY_GROUPS);
  for (const definition of visibleHotkeyDefinitions()) {
    assert.ok(groups.has(definition.group), `${definition.id} uses an unknown group`);
    assert.ok(definition.label.length > 0);
  }
});

test("accelerators render with platform-appropriate modifier labels", () => {
  assert.equal(formatAccelerator("CommandOrControl+Shift+A", "win32"), "Ctrl+Shift+A");
  assert.equal(formatAccelerator("CommandOrControl+Shift+A", "darwin"), "⌘⇧A");
  assert.equal(formatAccelerator("Alt+Left", "win32"), "Alt+Left");
  assert.equal(formatAccelerator("Alt+Left", "darwin"), "⌥Left");
  assert.equal(formatAccelerator("", "win32"), "");
});

test("keyboard events become Electron accelerators", () => {
  assert.equal(acceleratorFromKeyboard({ key: "b", ctrlKey: true }), "CommandOrControl+B");
  assert.equal(
    acceleratorFromKeyboard({ key: "ArrowLeft", ctrlKey: true, altKey: true, shiftKey: true }),
    "CommandOrControl+Alt+Shift+Left",
  );
  assert.equal(acceleratorFromKeyboard({ key: "Enter", ctrlKey: true }), "CommandOrControl+Enter");
  assert.equal(acceleratorFromKeyboard({ key: "Control", ctrlKey: true }), "");
  assert.equal(
    acceleratorFromKeyboard({ key: "k", metaKey: true }, "darwin"),
    "CommandOrControl+K",
  );
  assert.equal(
    acceleratorFromKeyboard({ key: "k", ctrlKey: true }, "darwin"),
    "Control+K",
  );
});

test("global shortcuts resolve CommandOrControl to a concrete modifier", () => {
  assert.equal(toGlobalAccelerator("CommandOrControl+H", "win32"), "Control+H");
  assert.equal(toGlobalAccelerator("CommandOrControl+H", "linux"), "Control+H");
  assert.equal(toGlobalAccelerator("CommandOrControl+H", "darwin"), "Command+H");
  assert.equal(toGlobalAccelerator("Control+H", "darwin"), "Control+H");
  assert.equal(toGlobalAccelerator("Command+H", "win32"), "Control+H");
  assert.equal(toGlobalAccelerator("Shift+CommandOrControl+A", "win32"), "Shift+Control+A");
  assert.equal(normalizeAccelerator("ctrl+shift+h"), "Control+Shift+H");

  for (const definition of HOTKEY_DEFINITIONS) {
    assert.ok(
      !toGlobalAccelerator(definition.accelerator, "win32").includes("CommandOrControl"),
      `${definition.id} still contains CommandOrControl`,
    );
  }
});

test("old default bindings migrate without overwriting custom bindings", () => {
  const settings = defaultHotkeys();
  settings.toggleOverlay = "Control+Shift+Space";
  settings.captureRegion = "Ctrl+Shift+S";
  settings.toggleListening = "CTRL+SHIFT+R";
  settings.resetView = "CommandOrControl+Shift+F9";

  const normalized = normalizeHotkeySettings(settings);

  assert.equal(normalized.toggleOverlay, "CommandOrControl+B");
  assert.equal(normalized.captureRegion, "CommandOrControl+H");
  assert.equal(normalized.toggleListening, "CommandOrControl+M");
  assert.equal(normalized.resetView, "CommandOrControl+Shift+F9");
});

test("custom bindings are canonicalized before persisting", () => {
  const settings = defaultHotkeys();
  settings.captureRegion = "ctrl+h";
  settings.captureFull = "CommandOrControl + Shift + A";

  const normalized = normalizeHotkeySettings(settings);

  assert.equal(normalized.captureRegion, "Control+H");
  assert.equal(normalized.captureFull, "CommandOrControl+Shift+A");
});
