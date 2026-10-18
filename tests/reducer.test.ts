import test from "node:test";
import assert from "node:assert/strict";
import { reduceSession } from "../src/shared/reducer.ts";
import type { Answer } from "../src/shared/models.ts";
import { segmentAt, sessionAt } from "./helpers.ts";

function answerAt(overrides: Partial<Answer> = {}): Answer {
  return {
    id: "a1",
    generationId: 7,
    question: "请解释事件循环",
    trigger: "manual",
    lane: "voice",
    status: "streaming",
    text: "",
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  };
}

test("appending the first segment does not change the session title", () => {
  const next = reduceSession(sessionAt(), {
    type: "segment.append",
    segment: segmentAt("请解释一下浏览器事件循环"),
    now: 1100,
  });
  assert.equal(next.segments.length, 1);
  assert.equal(next.title, "新的会话");
});

test("segment cap keeps the newest entries", () => {
  let session = sessionAt();
  for (let index = 0; index < 5; index += 1) {
    session = reduceSession(session, {
      type: "segment.append",
      segment: segmentAt(`第 ${index} 句`),
      now: 1000 + index,
      maxSegments: 3,
    });
  }
  assert.deepEqual(session.segments.map((entry) => entry.text), ["第 2 句", "第 3 句", "第 4 句"]);
});

test("removing one echoed segment keeps the surrounding transcript", () => {
  let session = sessionAt();
  session = reduceSession(session, {
    type: "segment.append",
    segment: segmentAt("第一句", { id: "seg_a" }),
    now: 1100,
  });
  session = reduceSession(session, {
    type: "segment.append",
    segment: segmentAt("第二句", { id: "seg_b" }),
    now: 1200,
  });
  session = reduceSession(session, {
    type: "segment.append",
    segment: segmentAt("第三句", { id: "seg_c" }),
    now: 1300,
  });
  const next = reduceSession(session, { type: "segment.remove", id: "seg_b", now: 1400 });
  assert.deepEqual(next.segments.map((entry) => entry.id), ["seg_a", "seg_c"]);
  assert.deepEqual(next.segments.map((entry) => entry.text), ["第一句", "第三句"]);
});

test("stale generation deltas are ignored", () => {
  const session = reduceSession(sessionAt(), { type: "answer.start", answer: answerAt(), now: 1100 });
  const next = reduceSession(session, {
    type: "answer.delta",
    answerId: "a1",
    generationId: 6,
    delta: "stale",
    now: 1200,
  });
  assert.equal(next, session);
  assert.equal(next.answers[0].text, "");
});

test("matching generation deltas append text", () => {
  let session = reduceSession(sessionAt(), { type: "answer.start", answer: answerAt(), now: 1100 });
  session = reduceSession(session, {
    type: "answer.delta",
    answerId: "a1",
    generationId: 7,
    delta: "事件循环",
    now: 1200,
  });
  session = reduceSession(session, {
    type: "answer.delta",
    answerId: "a1",
    generationId: 7,
    delta: "负责调度任务。",
    now: 1300,
  });
  assert.equal(session.answers[0].text, "事件循环负责调度任务。");
});

test("cancelling is not an error and clears inflight", () => {
  let session = reduceSession(sessionAt(), { type: "answer.start", answer: answerAt(), now: 1100 });
  session = reduceSession(session, {
    type: "answer.cancel",
    answerId: "a1",
    generationId: 7,
    now: 1200,
  });
  assert.equal(session.answers[0].status, "cancelled");
  assert.equal(session.answers[0].error, undefined);
  assert.equal(session.inflightAnswerId, null);
});

test("done clears inflight only for the current answer", () => {
  let session = reduceSession(sessionAt(), { type: "answer.start", answer: answerAt(), now: 1100 });
  session = reduceSession(session, {
    type: "answer.done",
    answerId: "a1",
    generationId: 7,
    now: 1300,
    model: "test-model",
  });
  assert.equal(session.answers[0].status, "done");
  assert.equal(session.answers[0].model, "test-model");
  assert.equal(session.inflightAnswerId, null);
});

test("voice and screenshot answers keep independent inflight pointers", () => {
  let session = reduceSession(sessionAt(), {
    type: "answer.start",
    answer: answerAt({ id: "v1", lane: "voice", question: "语音问题" }),
    now: 1100,
  });
  session = reduceSession(session, {
    type: "answer.start",
    answer: answerAt({
      id: "s1",
      generationId: 8,
      lane: "screenshot",
      trigger: "screenshot",
      question: "截图问题",
    }),
    now: 1200,
  });
  assert.equal(session.inflightAnswerId, "v1");
  assert.equal(session.inflightQuestion, "语音问题");
  assert.equal(session.inflightScreenshotAnswerId, "s1");
  assert.equal(session.inflightScreenshotQuestion, "截图问题");

  session = reduceSession(session, {
    type: "answer.done",
    answerId: "s1",
    generationId: 8,
    now: 1300,
  });
  assert.equal(session.inflightAnswerId, "v1");
  assert.equal(session.inflightScreenshotAnswerId, null);

  session = reduceSession(session, {
    type: "answer.done",
    answerId: "v1",
    generationId: 7,
    now: 1400,
  });
  assert.equal(session.inflightAnswerId, null);
  assert.equal(session.inflightScreenshotAnswerId, null);
});

test("trimming answers never drops a streaming answer", () => {
  let session = sessionAt();
  session.answers = [
    answerAt({ id: "a1", status: "done" }),
    answerAt({ id: "a2", status: "done" }),
    answerAt({ id: "a3", generationId: 8 }),
  ];
  const next = reduceSession(session, { type: "answers.trim", max: 2, now: 2000 });
  assert.deepEqual(next.answers.map((entry) => entry.id), ["a2", "a3"]);
});

test("queue push and remove are idempotent", () => {
  let session = sessionAt();
  const question = {
    id: "q1",
    speaker: "interviewer" as const,
    text: "问题",
    createdAt: 1,
    reason: "busy",
    lane: "voice" as const,
  };
  session = reduceSession(session, { type: "queue.push", question, now: 1100 });
  session = reduceSession(session, { type: "queue.push", question, now: 1200 });
  assert.equal(session.queue.length, 1);
  session = reduceSession(session, { type: "queue.remove", id: "q1", now: 1300 });
  assert.equal(session.queue.length, 0);
});

test("trigger marks are capped", () => {
  let session = sessionAt();
  for (let index = 0; index < 5; index += 1) {
    session = reduceSession(session, { type: "trigger.mark", normalized: `n${index}`, now: 1000 + index, keep: 2 });
  }
  assert.deepEqual(session.recentTriggers.map((entry) => entry.normalized), ["n3", "n4"]);
});
