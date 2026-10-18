import test from "node:test";
import assert from "node:assert/strict";
import type { CaptureGroup } from "../src/shared/models.ts";
import {
  GROUP_IDLE_MS,
  canAppendToGroup,
  createCaptureGroup,
  findGroupByShot,
  nextGroupSeq,
  pendingShotCount,
  pickCaptureGroup,
  reduceGroup,
} from "../src/shared/groups.ts";

function groupAt(overrides: Partial<CaptureGroup> = {}): CaptureGroup {
  return {
    ...createCaptureGroup({
      id: "grp_1",
      seq: 1,
      sessionId: "sess_1",
      screenshotId: "shot_1",
      now: 1_000,
    }),
    ...overrides,
  };
}

test("appending screenshots keeps a group collecting and deduplicates ids", () => {
  const first = reduceGroup(groupAt(), { type: "group.append", shotId: "shot_2", now: 2_000 });
  assert.deepEqual(first.screenshotIds, ["shot_1", "shot_2"]);
  assert.equal(first.status, "collecting");
  assert.equal(first.updatedAt, 2_000);

  const duplicate = reduceGroup(first, { type: "group.append", shotId: "shot_2", now: 3_000 });
  assert.equal(duplicate, first);
});

test("appending after an error clears the failure and resumes collecting", () => {
  const failed = groupAt({ status: "error", lastError: "模型未配置", updatedAt: 2_000 });
  const resumed = reduceGroup(failed, { type: "group.append", shotId: "shot_2", now: 3_000 });
  assert.equal(resumed.status, "collecting");
  assert.equal(resumed.lastError, undefined);
  assert.deepEqual(resumed.screenshotIds, ["shot_1", "shot_2"]);
});

test("a group can append only inside the idle window", () => {
  const group = groupAt({ status: "collecting", updatedAt: 10_000 });
  assert.equal(pickCaptureGroup([group], 10_000 + GROUP_IDLE_MS)?.id, group.id);
  assert.equal(pickCaptureGroup([group], 10_000 + GROUP_IDLE_MS + 1), null);
});

test("answered and closed groups are not automatic append targets", () => {
  const answered = groupAt({ status: "answered", updatedAt: 10_000 });
  const closed = groupAt({ id: "grp_2", seq: 2, status: "closed", updatedAt: 10_000 });
  assert.equal(pickCaptureGroup([answered], 10_000), null);
  assert.equal(pickCaptureGroup([closed], 10_000), null);
  assert.equal(canAppendToGroup(answered), false);
  assert.equal(canAppendToGroup(closed), false);
});

test("reopening a group clears errors and returns it to collecting", () => {
  const answered = groupAt({ status: "answered", lastError: "旧错误", updatedAt: 2_000 });
  const reopened = reduceGroup(answered, { type: "group.reopen", now: 3_000 });
  assert.equal(reopened.status, "collecting");
  assert.equal(reopened.lastError, undefined);
  assert.equal(reopened.updatedAt, 3_000);
});

test("closing locks a group but never interrupts an answer", () => {
  const closed = reduceGroup(groupAt({ status: "collecting" }), { type: "group.close", now: 2_000 });
  assert.equal(closed.status, "closed");

  const answering = groupAt({ status: "answering" });
  assert.equal(reduceGroup(answering, { type: "group.close", now: 2_000 }), answering);
  assert.equal(reduceGroup(answering, { type: "group.reopen", now: 2_000 }), answering);
});

test("cancelling an answer returns the group to collecting and clears errors", () => {
  const answering = groupAt({ status: "answering", answerId: "ans_1", lastError: "旧错误", updatedAt: 2_000 });
  const cancelled = reduceGroup(answering, { type: "group.cancel", now: 3_000 });
  assert.equal(cancelled.status, "collecting");
  assert.equal(cancelled.lastError, undefined);
  assert.equal(cancelled.updatedAt, 3_000);
  assert.equal(cancelled.answerId, "ans_1");
});

test("answer transitions track solved screenshots and ignore stale answers", () => {
  const started = reduceGroup(groupAt(), {
    type: "group.answering",
    answerId: "ans_1",
    shotCount: 2,
    now: 2_000,
  });
  assert.equal(started.status, "answering");
  assert.equal(started.answerId, "ans_1");
  assert.equal(started.solvedShotCount, 1);

  const stale = reduceGroup(started, { type: "group.answered", answerId: "ans_old", now: 3_000 });
  assert.equal(stale.status, "answering");
  assert.equal(stale.answerId, "ans_1");

  const done = reduceGroup(started, { type: "group.answered", answerId: "ans_1", now: 3_000 });
  assert.equal(done.status, "answered");
  assert.equal(done.answerIds.includes("ans_1"), true);
});

test("pending shot count only includes screenshots added after the last solve", () => {
  const group = groupAt({
    status: "answered",
    answerId: "ans_1",
    screenshotIds: ["shot_1", "shot_2", "shot_3"],
    solvedShotCount: 2,
  });
  assert.equal(pendingShotCount(group), 1);
  assert.equal(findGroupByShot([group], "shot_3")?.id, group.id);
  assert.equal(findGroupByShot([group], "shot_x"), null);
});

test("next group sequence follows the highest existing sequence", () => {
  assert.equal(nextGroupSeq([]), 1);
  assert.equal(nextGroupSeq([groupAt({ seq: 2 }), groupAt({ id: "grp_3", seq: 7 })]), 8);
});
