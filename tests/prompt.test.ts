import test from "node:test";
import assert from "node:assert/strict";
import { buildAnswerMessages, buildTranscriptWindow, buildVisionPrompt } from "../src/shared/prompt.ts";

test("answer messages include system rules, transcript and knowledge", () => {
  const messages = buildAnswerMessages("如何优化首屏性能？", {
    style: "concise",
    transcript: [
      { speaker: "me", text: "我之前做过性能优化。" },
      { speaker: "interviewer", text: "如何优化首屏性能？" },
    ],
    kbChunks: [{ docName: "perf.md", text: "使用代码分割与预加载。" }],
  });
  assert.equal(messages.length, 2);
  assert.equal(messages[0].role, "system");
  assert.ok(messages[0].content.includes("实时面试"));
  assert.ok(messages[1].content.includes("perf.md"));
  assert.ok(messages[1].content.includes("如何优化首屏性能"));
  assert.ok(messages[1].content.includes("我："));
  assert.ok(messages[1].content.includes("对方："));
});

test("STAR style changes the system instructions", () => {
  const messages = buildAnswerMessages("讲一个项目", { style: "star" });
  assert.ok(messages[0].content.includes("STAR"));
});

test("screenshot prompts mention the image", () => {
  const messages = buildAnswerMessages("看图回答", { style: "concise", screenshot: true });
  assert.ok(messages[1].content.includes("截图"));
  assert.ok(buildVisionPrompt("重点看第二问").includes("重点看第二问"));
});

test("transcript window keeps a bounded suffix", () => {
  const segments = Array.from({ length: 10 }, (_, index) => ({ speaker: "interviewer" as const, text: `第${index}段` }));
  const picked = buildTranscriptWindow(segments, 20);
  assert.ok(picked.length < segments.length);
  assert.equal(picked[picked.length - 1].text, "第9段");
});