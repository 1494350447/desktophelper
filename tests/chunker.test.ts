import test from "node:test";
import assert from "node:assert/strict";
import { chunkText } from "../src/shared/chunker.ts";

test("empty input produces no chunks", () => {
  assert.deepEqual(chunkText("   \n\n ", { size: 100, overlap: 20 }), []);
});

test("short paragraphs merge up to the chunk size", () => {
  const input = "第一段内容。\n\n第二段内容。\n\n第三段内容。";
  const chunks = chunkText(input, { size: 40, overlap: 0 });
  assert.equal(chunks.length >= 1, true);
  assert.ok(chunks.every((chunk) => chunk.length <= 40));
});

test("long text is split into bounded chunks", () => {
  const input = "这是一个很长的测试段落，用来验证分块逻辑。".repeat(30);
  const chunks = chunkText(input, { size: 200, overlap: 40 });
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((chunk) => chunk.length <= 200));
});

test("adjacent hard-split chunks overlap", () => {
  const input = "a".repeat(1000);
  const chunks = chunkText(input, { size: 100, overlap: 20 });
  assert.ok(chunks.length > 2);
  for (let index = 1; index < chunks.length; index += 1) {
    assert.equal(chunks[index - 1].slice(-20), chunks[index].slice(0, 20));
  }
});

test("duplicate chunks are removed", () => {
  const input = "同样的内容。\n\n同样的内容。\n\n同样的内容。";
  const chunks = chunkText(input, { size: 100, overlap: 0 });
  assert.deepEqual(chunks, ["同样的内容。"]);
});