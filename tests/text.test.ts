import test from "node:test";
import assert from "node:assert/strict";
import {
  countChars,
  intervalOverlapRatio,
  isLikelySameUtterance,
  looksLikeQuestion,
  makeTitle,
  normalizeForCompare,
  normalizeWhitespace,
  textSimilarity,
  truncate,
} from "../src/shared/text.ts";
import { createId } from "../src/shared/ids.ts";

test("countChars ignores whitespace", () => {
  assert.equal(countChars("你 好\n世界"), 4);
  assert.equal(countChars("  a b  "), 2);
});

test("normalization removes punctuation for dedupe", () => {
  assert.equal(normalizeForCompare("请解释，事件循环！"), "请解释事件循环");
  assert.equal(normalizeForCompare("Hello, World!"), "helloworld");
  assert.equal(normalizeWhitespace("  a   b  "), "a b");
});

test("echo detection tolerates punctuation and small ASR differences", () => {
  assert.ok(textSimilarity("请介绍一下你最近做过的项目？", "请介绍一下你最近做过的项目") > 0.85);
  assert.equal(isLikelySameUtterance("请介绍一下你最近做过的项目？", "请介绍一下你最近做过的项目"), true);
  assert.equal(isLikelySameUtterance("请介绍一下你最近做过的项目", "请说明一下你最近参与的项目"), false);
});

test("utterance interval overlap uses the shorter speech span", () => {
  assert.equal(intervalOverlapRatio(0, 2000, 400, 1800), 1);
  assert.equal(intervalOverlapRatio(0, 2000, 2400, 4000), 0);
  assert.ok(intervalOverlapRatio(0, 2000, 1500, 3500) > 0.2);
  assert.equal(intervalOverlapRatio(0, 0, 100, 900), 0);
});

test("question detection covers CJK and English", () => {
  assert.equal(looksLikeQuestion("这是什么？"), true);
  assert.equal(looksLikeQuestion("How does it work"), true);
  assert.equal(looksLikeQuestion("今天天气不错"), false);
});

test("titles and truncation are bounded", () => {
  assert.equal(makeTitle("  请解释事件循环机制  "), "请解释事件循环机制");
  assert.equal(truncate("abcdef", 4), "abc…");
});

test("ids are prefixed and unique", () => {
  const first = createId("seg", { now: 1000, random: () => 0.5 });
  const second = createId("seg", { now: 1000, random: () => 0.5 });
  assert.ok(first.startsWith("seg_"));
  assert.notEqual(first, second);
});
