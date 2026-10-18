import type {
  ExtractedProblem,
  ScreenshotRoute,
  ScreenshotStrategy,
} from "./models.ts";
import { truncate } from "./text.ts";

export type ScreenshotCapabilities = {
  vision: boolean;
  extraction: boolean;
};

export const MAX_EXTRACTED_CHARS = 24000;

export function chooseScreenshotStrategy(
  preference: ScreenshotStrategy,
  capabilities: ScreenshotCapabilities,
): ScreenshotRoute | null {
  if (preference === "vision") return capabilities.vision ? "vision" : null;
  if (preference === "extract") return capabilities.extraction ? "extract" : null;
  if (capabilities.vision) return "vision";
  if (capabilities.extraction) return "extract";
  return null;
}

export function shouldFallbackToExtract(
  route: ScreenshotRoute,
  fallbackEnabled: boolean,
  capabilities: ScreenshotCapabilities,
): boolean {
  return route === "vision" && fallbackEnabled && capabilities.extraction;
}

function pickString(value: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  return "";
}

function stripFence(text: string): string {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  return trimmed.trim();
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  const candidate = stripFence(text);
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(candidate.slice(start, end + 1)) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export function parseExtractedProblem(raw: unknown): ExtractedProblem | null {
  let value: Record<string, unknown> | null = null;
  if (typeof raw === "string") {
    value = parseJsonObject(raw);
    if (!value) {
      const plain = stripFence(raw);
      if (!plain) return null;
      return {
        problemStatement: truncate(plain, MAX_EXTRACTED_CHARS),
        additionalContext: "",
      };
    }
  } else if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    value = raw as Record<string, unknown>;
  }
  if (!value) return null;
  const problemStatement = pickString(value, [
    "problem_statement",
    "problemStatement",
    "problem",
    "question",
    "题面",
  ]);
  const additionalContext = pickString(value, [
    "additional_context",
    "additionalContext",
    "context",
    "补充",
  ]);
  if (!problemStatement && !additionalContext) return null;
  return {
    problemStatement: truncate(problemStatement, MAX_EXTRACTED_CHARS),
    additionalContext: truncate(additionalContext, MAX_EXTRACTED_CHARS),
  };
}

export function mergeExtractedProblems(parts: ExtractedProblem[]): ExtractedProblem {
  const usable = parts.filter((part) => part.problemStatement.trim() || part.additionalContext.trim());
  if (usable.length === 0) return { problemStatement: "", additionalContext: "" };
  if (usable.length === 1) return usable[0];
  return {
    problemStatement: truncate(
      usable
        .map((part, index) => `【第 ${index + 1} 张图】\n${part.problemStatement}`.trim())
        .join("\n\n"),
      MAX_EXTRACTED_CHARS,
    ),
    additionalContext: truncate(
      usable
        .map((part, index) => `【第 ${index + 1} 张图】\n${part.additionalContext}`.trim())
        .join("\n\n"),
      MAX_EXTRACTED_CHARS,
    ),
  };
}

export function screenshotQuestion(extracted: ExtractedProblem, note?: string): string {
  const base = extracted.problemStatement || "请分析截图中的题目并给出完整解答";
  const extra = note?.trim();
  return extra ? `${base}\n\n补充要求：${extra}` : base;
}

export type ProblemKind = "code" | "general";

export function detectProblemKind(text: string): ProblemKind {
  const sample = text.toLowerCase();
  const codeSignals = [
    "```",
    "代码",
    "编程",
    "函数",
    "算法",
    "复杂度",
    "二分",
    "排序",
    "查找",
    "动态规划",
    "sql",
    "select ",
    "class ",
    "function",
    "def ",
    "public ",
    "输入输出",
    "时间复杂度",
  ];
  return codeSignals.some((signal) => sample.includes(signal)) ? "code" : "general";
}

export type ContinuationInput = {
  previousProblem?: string;
  previousAnswer: string;
  newExtraction?: ExtractedProblem;
  note?: string;
};

export function buildContinuationContext(input: ContinuationInput): string {
  const sections: string[] = [];
  if (input.previousProblem?.trim()) {
    sections.push(`[原题信息]\n${truncate(input.previousProblem.trim(), 12000)}`);
  }
  sections.push(`[上一版完整解答]\n${truncate(input.previousAnswer.trim(), 24000)}`);
  if (input.newExtraction && (input.newExtraction.problemStatement || input.newExtraction.additionalContext)) {
    const lines = [
      input.newExtraction.problemStatement,
      input.newExtraction.additionalContext
        ? `补充信息：${input.newExtraction.additionalContext}`
        : "",
    ].filter(Boolean);
    sections.push(`[本次补图提取内容]\n${lines.join("\n")}`);
  }
  if (input.note?.trim()) sections.push(`[补充要求]\n${truncate(input.note.trim(), 2000)}`);
  return sections.join("\n\n");
}
