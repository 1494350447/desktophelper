import test from "node:test";
import assert from "node:assert/strict";
import { searchChunks, tokenize } from "../src/shared/bm25.ts";
import type { KnowledgeChunk } from "../src/shared/models.ts";

function chunk(id: string, docName: string, text: string, index = 0): KnowledgeChunk {
  return { id, docId: `d_${docName}`, docName, index, text };
}

const chunks: KnowledgeChunk[] = [
  chunk("c1", "js.md", "事件循环负责调度宏任务和微任务，微任务在每次宏任务结束后清空。"),
  chunk("c2", "react.md", "React 的 useEffect 在渲染后执行，依赖数组决定副作用的触发时机。"),
  chunk("c3", "http.md", "HTTP 缓存通过 Cache-Control 与 ETag 进行协商，强缓存优先于协商缓存。"),
  chunk("c4", "js.md", "闭包是函数与其词法作用域的组合，常用于封装私有状态。", 1),
];

test("tokenizer emits CJK unigrams and bigrams", () => {
  const tokens = tokenize("事件循环");
  assert.ok(tokens.includes("事"));
  assert.ok(tokens.includes("事件"));
  assert.ok(tokens.includes("循环"));
});

test("Chinese query ranks the matching chunk first", () => {
  const hits = searchChunks(chunks, "微任务 事件循环", 3);
  assert.equal(hits[0].chunk.id, "c1");
  assert.ok(hits[0].score > 0);
});

test("English query ranks the matching chunk first", () => {
  const hits = searchChunks(chunks, "useEffect dependency", 3);
  assert.equal(hits[0].chunk.id, "c2");
});

test("topK limits results", () => {
  const hits = searchChunks(chunks, "缓存", 1);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].chunk.id, "c3");
});

test("empty query returns nothing", () => {
  assert.deepEqual(searchChunks(chunks, "   ", 4), []);
});

test("unmatched query returns nothing", () => {
  assert.deepEqual(searchChunks(chunks, "quantum blockchain", 4), []);
});