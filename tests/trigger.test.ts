import test from "node:test";
import assert from "node:assert/strict";
import { evaluateSegment, shouldTriggerManually } from "../src/shared/trigger.ts";
import { defaultSettings, emptySession } from "../src/shared/models.ts";
import { segmentAt, sessionAt } from "./helpers.ts";

test("target speaker filter ignores the user's own speech", () => {
  const settings = defaultSettings();
  const session = sessionAt();
  const decision = evaluateSegment(session, segmentAt("请解释一下事件循环", { speaker: "me" }), settings, 1000);
  assert.equal(decision.action, "ignore");
  assert.equal(decision.reason, "speaker-mismatch");
});

test("short segments are ignored", () => {
  const settings = defaultSettings();
  settings.trigger.minChars = 6;
  const decision = evaluateSegment(sessionAt(), segmentAt("你好"), settings, 1000);
  assert.equal(decision.action, "ignore");
  assert.equal(decision.reason, "too-short");
});

test("a valid interviewer question triggers an answer", () => {
  const settings = defaultSettings();
  const decision = evaluateSegment(sessionAt(), segmentAt("请解释一下浏览器的事件循环机制"), settings, 1000);
  assert.equal(decision.action, "answer");
  assert.equal(decision.reason, "question");
  assert.ok(decision.normalized);
});

test("throttled questions are queued instead of answered", () => {
  const settings = defaultSettings();
  settings.trigger.throttleMs = 6000;
  const session = sessionAt();
  session.lastTriggerAt = 1000;
  const decision = evaluateSegment(session, segmentAt("第二个问题：如何优化渲染性能"), settings, 3000);
  assert.equal(decision.action, "queue");
  assert.equal(decision.reason, "throttled");
});

test("questions arriving while an answer streams are queued", () => {
  const settings = defaultSettings();
  const session = sessionAt();
  session.inflightAnswerId = "answer_1";
  const decision = evaluateSegment(session, segmentAt("请说说你对闭包的理解"), settings, 1000);
  assert.equal(decision.action, "queue");
  assert.equal(decision.reason, "busy");
});

test("duplicate questions inside the dedupe window are ignored", () => {
  const settings = defaultSettings();
  settings.trigger.dedupeWindowMs = 20000;
  const session = sessionAt();
  const question = "请解释一下事件循环机制";
  session.recentTriggers.push({ normalized: "请解释一下事件循环机制", at: 1000 });
  const decision = evaluateSegment(session, segmentAt(question), settings, 5000);
  assert.equal(decision.action, "ignore");
  assert.equal(decision.reason, "duplicate");
});

test("autoAnswer disabled ignores new questions", () => {
  const settings = defaultSettings();
  settings.trigger.autoAnswer = false;
  const decision = evaluateSegment(sessionAt(), segmentAt("请解释一下事件循环机制"), settings, 1000);
  assert.equal(decision.action, "ignore");
  assert.equal(decision.reason, "auto-disabled");
});

test("queued duplicates are not queued twice", () => {
  const settings = defaultSettings();
  const session = emptySession("s", 1);
  session.queue.push({
    id: "q1",
    speaker: "interviewer",
    text: "请详细说说闭包",
    createdAt: 1,
    reason: "busy",
    lane: "voice",
  });
  const decision = evaluateSegment(session, segmentAt("请详细说说闭包"), settings, 1000);
  assert.equal(decision.action, "ignore");
  assert.equal(decision.reason, "already-queued");
});

test("manual trigger accepts short questions", () => {
  const decision = shouldTriggerManually("闭包", 6);
  assert.equal(decision.action, "answer");
  assert.equal(decision.reason, "manual");
});
