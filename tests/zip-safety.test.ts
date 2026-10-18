import test from "node:test";
import assert from "node:assert/strict";
import { isSafeZipEntryName } from "../scripts/zip-safety.mjs";

test("ZIP entry names must be ASCII-safe on Windows", () => {
  assert.equal(isSafeZipEntryName("Desktophelper-0.1.1-win-x64/README.txt"), true);
  assert.equal(isSafeZipEntryName("Desktophelper-0.1.1-win-x64/resources/app/main/index.mjs"), true);
  assert.equal(isSafeZipEntryName("Desktophelper-0.1.1-win-x64/????.txt"), false);
  assert.equal(isSafeZipEntryName("Desktophelper-0.1.1-win-x64/启动说明.txt"), false);
  assert.equal(isSafeZipEntryName("../escape.txt"), false);
  assert.equal(isSafeZipEntryName("C:/absolute.txt"), false);
  assert.equal(isSafeZipEntryName("dir" + String.fromCharCode(92) + "file.txt"), false);
});
