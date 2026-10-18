import test from "node:test";
import assert from "node:assert/strict";
import { renderMarkdown } from "../src/shared/markdown.ts";

test("HTML is escaped", () => {
  const html = renderMarkdown('<img src=x onerror="alert(1)">');
  assert.equal(html.includes("<img"), false);
  assert.ok(html.includes("&lt;img"));
});

test("fenced code is escaped and keeps the language", () => {
  const html = renderMarkdown("```js\nconst a = 1 < 2;\n```");
  assert.ok(html.includes('<pre><code class="language-js">'));
  assert.ok(html.includes("1 &lt; 2"));
});

test("lists render as list elements", () => {
  const html = renderMarkdown("- 第一项\n- 第二项");
  assert.ok(html.includes("<ul>"));
  assert.ok(html.includes("<li>第一项</li>"));
});

test("bold and inline code render", () => {
  const html = renderMarkdown("这是 **重点** 和 `code`");
  assert.ok(html.includes("<strong>重点</strong>"));
  assert.ok(html.includes("<code>code</code>"));
});

test("only http links become anchors", () => {
  const safe = renderMarkdown("[文档](https://example.com/a)");
  assert.ok(safe.includes('href="https://example.com/a"'));
  const unsafe = renderMarkdown("[点我](javascript:alert(1))");
  assert.equal(unsafe.includes("<a "), false);
  assert.equal(unsafe.includes("href"), false);
});

test("headings and blockquotes render", () => {
  const html = renderMarkdown("# 标题\n\n> 引用");
  assert.ok(html.includes("<h1>标题</h1>"));
  assert.ok(html.includes("<blockquote>"));
});