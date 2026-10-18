import type { KnowledgeChunk } from "./models.ts";
import { isCjk } from "./text.ts";

const STOPWORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "that",
  "this",
  "are",
  "was",
  "were",
  "you",
  "your",
  "have",
  "has",
  "from",
  "not",
  "but",
  "can",
  "will",
  "would",
  "there",
  "their",
  "about",
  "into",
  "they",
  "them",
  "then",
  "than",
  "what",
  "when",
  "where",
  "which",
  "who",
  "why",
  "how",
  "的",
  "了",
  "是",
  "在",
  "和",
  "与",
  "及",
  "或",
  "一个",
  "我们",
  "你们",
  "他们",
  "这个",
  "那个",
  "什么",
  "怎么",
]);

export function tokenize(text: string): string[] {
  const tokens: string[] = [];
  const lower = text.toLowerCase();
  const latin = lower.match(/[a-z0-9_+#.]{2,}/g) ?? [];
  for (const word of latin) {
    if (!STOPWORDS.has(word)) tokens.push(word);
  }
  const chars = Array.from(lower);
  for (let index = 0; index < chars.length; index += 1) {
    const char = chars[index];
    if (!isCjk(char)) continue;
    if (!STOPWORDS.has(char)) tokens.push(char);
    const next = chars[index + 1];
    if (next && isCjk(next)) {
      const bigram = char + next;
      if (!STOPWORDS.has(bigram)) tokens.push(bigram);
    }
  }
  return tokens;
}

export type ScoredChunk = {
  chunk: KnowledgeChunk;
  score: number;
};

export function searchChunks(chunks: KnowledgeChunk[], query: string, topK = 4): ScoredChunk[] {
  const queryTokens = tokenize(query);
  if (queryTokens.length === 0 || chunks.length === 0) return [];
  const uniqueQuery = Array.from(new Set(queryTokens));

  const documents = chunks.map((chunk) => {
    const tokens = tokenize(chunk.text);
    const freq = new Map<string, number>();
    for (const token of tokens) freq.set(token, (freq.get(token) ?? 0) + 1);
    return { chunk, tokens, freq, length: tokens.length };
  });

  const averageLength = documents.reduce((sum, doc) => sum + doc.length, 0) / documents.length || 1;
  const docFreq = new Map<string, number>();
  for (const token of uniqueQuery) {
    let df = 0;
    for (const doc of documents) if (doc.freq.has(token)) df += 1;
    docFreq.set(token, df);
  }

  const k1 = 1.2;
  const b = 0.75;
  const total = documents.length;
  const scored: ScoredChunk[] = [];

  for (const doc of documents) {
    let score = 0;
    for (const token of uniqueQuery) {
      const freq = doc.freq.get(token) ?? 0;
      if (freq === 0) continue;
      const df = docFreq.get(token) ?? 0;
      const idf = Math.log(1 + (total - df + 0.5) / (df + 0.5));
      const denominator = freq + k1 * (1 - b + b * (doc.length / averageLength));
      score += idf * ((freq * (k1 + 1)) / denominator);
    }
    if (score > 0) scored.push({ chunk: doc.chunk, score: Number(score.toFixed(4)) });
  }

  scored.sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score;
    if (left.chunk.docName !== right.chunk.docName) return left.chunk.docName.localeCompare(right.chunk.docName);
    return left.chunk.index - right.chunk.index;
  });
  return scored.slice(0, Math.max(1, topK));
}

export function tokenizeForTest(text: string): string[] {
  return tokenize(text);
}