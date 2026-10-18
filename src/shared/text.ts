const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/;
const INTERROGATIVES = [
  "什么",
  "为什么",
  "怎么",
  "如何",
  "是否",
  "能否",
  "请问",
  "介绍一下",
  "解释",
  "说说",
  "谈谈",
  "区别",
  "实现",
  "设计",
  "优化",
  "what",
  "why",
  "how",
  "when",
  "where",
  "which",
  "who",
  "explain",
  "describe",
  "design",
  "implement",
  "compare",
  "tell me",
];

export function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function normalizeForCompare(text: string): string {
  return normalizeWhitespace(text)
    .toLowerCase()
    .replace(/[\s"'`“”‘’.,!?;:，。！？；：、…\-_/\\()[\]{}<>]+/g, "");
}

function bigrams(value: string): Set<string> {
  const grams = new Set<string>();
  if (value.length < 2) {
    if (value) grams.add(value);
    return grams;
  }
  for (let index = 0; index < value.length - 1; index += 1) {
    grams.add(value.slice(index, index + 2));
  }
  return grams;
}

/**
 * Similarity of two normalized strings in the 0..1 range. Bigram overlap is
 * used because it tolerates small ASR differences in CJK and Latin text.
 */
export function textSimilarity(left: string, right: string): number {
  const a = normalizeForCompare(left);
  const b = normalizeForCompare(right);
  if (!a || !b) return 0;
  if (a === b) return 1;
  const leftGrams = bigrams(a);
  const rightGrams = bigrams(b);
  let shared = 0;
  for (const gram of leftGrams) {
    if (rightGrams.has(gram)) shared += 1;
  }
  if (shared === 0) return 0;
  const union = leftGrams.size + rightGrams.size - shared;
  const jaccard = union > 0 ? shared / union : 0;
  const containment = shared / Math.min(leftGrams.size, rightGrams.size);
  return Math.max(jaccard, containment * 0.92);
}

/**
 * Cross-channel echo detection. A microphone final that closely matches a
 * recent system-audio final is almost always speaker leakage, while genuinely
 * different speech stays untouched.
 */
export function isLikelySameUtterance(left: string, right: string, threshold = 0.76): boolean {
  const a = normalizeForCompare(left);
  const b = normalizeForCompare(right);
  if (!a || !b) return false;
  if (a === b) return a.length >= 2;
  const shorter = a.length <= b.length ? a : b;
  const longer = a.length <= b.length ? b : a;
  if (shorter.length < 6) return false;
  if (longer.includes(shorter)) return shorter.length / longer.length >= 0.55;
  return textSimilarity(a, b) >= threshold;
}

/**
 * Fraction of the shorter interval covered by both intervals. ASR timestamps
 * from the microphone and loopback channels are comparable enough to tell an
 * echoed utterance from genuinely different speech.
 */
export function intervalOverlapRatio(
  leftStart: number,
  leftEnd: number,
  rightStart: number,
  rightEnd: number,
): number {
  if (!(leftEnd > leftStart) || !(rightEnd > rightStart)) return 0;
  const overlap = Math.max(0, Math.min(leftEnd, rightEnd) - Math.max(leftStart, rightStart));
  return overlap / Math.min(leftEnd - leftStart, rightEnd - rightStart);
}

export function countChars(text: string): number {
  let count = 0;
  for (const char of text) {
    if (!/\s/.test(char)) count += 1;
  }
  return count;
}

export function isCjk(char: string): boolean {
  return CJK.test(char);
}

export function looksLikeQuestion(text: string): boolean {
  const value = normalizeWhitespace(text);
  if (!value) return false;
  if (/[?？]\s*$/.test(value)) return true;
  const lower = value.toLowerCase();
  return INTERROGATIVES.some((word) => lower.includes(word));
}

export function sentenceScore(text: string): number {
  const value = normalizeWhitespace(text);
  let score = 0;
  if (/[?？]\s*$/.test(value)) score += 3;
  const lower = value.toLowerCase();
  score += INTERROGATIVES.filter((word) => lower.includes(word)).length;
  if (value.length >= 8 && value.length <= 240) score += 1;
  return score;
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}

export function makeTitle(text: string, max = 22): string {
  const value = normalizeWhitespace(text);
  if (!value) return "新的会话";
  return truncate(value, max);
}

export function stripProtocol(url: string): string {
  return url.replace(/\/+$/, "").replace(/\/v1$/, "");
}

export function formatTime(timestamp: number): string {
  const date = new Date(timestamp);
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}
