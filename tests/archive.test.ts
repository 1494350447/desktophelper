import test from "node:test";
import assert from "node:assert/strict";
import { archiveRetryDelay, checkArchiveGuard } from "../src/shared/archive.ts";

const screenshot = {
  requestId: "req_1",
  screenshotContextId: "ctx_1",
  archiveRequestId: "arc_1",
  archiveState: "pending" as const,
};

test("archive requires all three ids to match", () => {
  assert.deepEqual(
    checkArchiveGuard(screenshot, { requestId: "req_1", screenshotContextId: "ctx_1", archiveRequestId: "arc_1" }),
    { ok: true },
  );
  assert.deepEqual(
    checkArchiveGuard(screenshot, { requestId: "req_2", screenshotContextId: "ctx_1", archiveRequestId: "arc_1" }),
    { ok: false, reason: "request-mismatch" },
  );
  assert.deepEqual(
    checkArchiveGuard(screenshot, { requestId: "req_1", screenshotContextId: "ctx_2", archiveRequestId: "arc_1" }),
    { ok: false, reason: "context-mismatch" },
  );
  assert.deepEqual(
    checkArchiveGuard(screenshot, { requestId: "req_1", screenshotContextId: "ctx_1", archiveRequestId: "arc_2" }),
    { ok: false, reason: "archive-mismatch" },
  );
});

test("an archived screenshot cannot be archived again", () => {
  const archived = { ...screenshot, archiveState: "archived" as const };
  const result = checkArchiveGuard(archived, {
    requestId: "req_1",
    screenshotContextId: "ctx_1",
    archiveRequestId: "arc_1",
  });
  assert.deepEqual(result, { ok: false, reason: "already-archived" });
});

test("retry delay grows but is capped", () => {
  assert.equal(archiveRetryDelay(0), 500);
  assert.equal(archiveRetryDelay(1), 1000);
  assert.equal(archiveRetryDelay(10), 30000);
});