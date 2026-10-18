import test from "node:test";
import assert from "node:assert/strict";
import {
  buildContinuationContext,
  chooseScreenshotStrategy,
  detectProblemKind,
  mergeExtractedProblems,
  parseExtractedProblem,
  screenshotQuestion,
  shouldFallbackToExtract,
} from "../src/shared/screenshot.ts";
import { buildExtractionPrompt, buildSolutionMessages, buildVisionSolutionPrompt } from "../src/shared/prompt.ts";

test("screenshot strategy prefers vision in auto mode and reports missing capabilities", () => {
  assert.equal(chooseScreenshotStrategy("auto", { vision: true, extraction: true }), "vision");
  assert.equal(chooseScreenshotStrategy("auto", { vision: false, extraction: true }), "extract");
  assert.equal(chooseScreenshotStrategy("vision", { vision: false, extraction: true }), null);
  assert.equal(chooseScreenshotStrategy("extract", { vision: true, extraction: false }), null);
  assert.equal(chooseScreenshotStrategy("auto", { vision: false, extraction: false }), null);
});

test("vision fallback requires extraction capability and an enabled switch", () => {
  assert.equal(shouldFallbackToExtract("vision", true, { vision: true, extraction: true }), true);
  assert.equal(shouldFallbackToExtract("vision", false, { vision: true, extraction: true }), false);
  assert.equal(shouldFallbackToExtract("extract", true, { vision: true, extraction: true }), false);
  assert.equal(shouldFallbackToExtract("vision", true, { vision: true, extraction: false }), false);
});

test("extraction parser accepts fenced JSON, alternate keys and plain text", () => {
  const fenced = parseExtractedProblem('```json\n{"problem_statement":"实现 LRU","additional_context":"容量为 2"}\n```');
  assert.deepEqual(fenced, { problemStatement: "实现 LRU", additionalContext: "容量为 2" });

  const alternate = parseExtractedProblem({ problemStatement: "求最短路径", context: "图无负环" });
  assert.deepEqual(alternate, { problemStatement: "求最短路径", additionalContext: "图无负环" });

  const plain = parseExtractedProblem("  写出快速排序，并说明复杂度。  ");
  assert.equal(plain?.problemStatement, "写出快速排序，并说明复杂度。");
  assert.equal(plain?.additionalContext, "");

  assert.equal(parseExtractedProblem("   "), null);
  assert.equal(parseExtractedProblem("{}"), null);
});

test("continuation merges new screenshots without dropping earlier problem text", () => {
  const merged = mergeExtractedProblems([
    { problemStatement: "第一问：求最大值", additionalContext: "数组长度 10" },
    { problemStatement: "第二问：求最小值", additionalContext: "要求 O(n)" },
  ]);
  assert.ok(merged.problemStatement.includes("第一问"));
  assert.ok(merged.problemStatement.includes("第二问"));
  assert.ok(merged.additionalContext.includes("要求 O(n)"));

  const context = buildContinuationContext({
    previousProblem: "第一问",
    previousAnswer: "## 解题思路\n旧答案",
    newExtraction: { problemStatement: "补充：输入范围", additionalContext: "" },
  });
  assert.ok(context.includes("上一版完整解答"));
  assert.ok(context.includes("本次补图提取内容"));
  assert.ok(context.includes("补充：输入范围"));
});

test("problem kind drives the output headings", () => {
  assert.equal(detectProblemKind("用 Python 实现一个函数，并分析时间复杂度"), "code");
  assert.equal(detectProblemKind("请解释什么是 CAP 定理"), "general");

  const code = buildSolutionMessages({ problem: "实现二分查找" });
  assert.ok(code[1].content.includes("## 复杂度分析"));
  const general = buildSolutionMessages({ problem: "解释 CAP 定理" });
  assert.ok(general[1].content.includes("## 详细解析"));
  assert.ok(buildVisionSolutionPrompt({ problem: "看图作答" }).includes("附图中"));
});

test("extraction prompt asks for the stable JSON contract", () => {
  const prompt = buildExtractionPrompt();
  assert.ok(prompt.includes("problem_statement"));
  assert.ok(prompt.includes("additional_context"));
  assert.ok(prompt.includes("忽略"));
  assert.ok(screenshotQuestion({ problemStatement: "题面", additionalContext: "" }, "用 Java").includes("用 Java"));
});
