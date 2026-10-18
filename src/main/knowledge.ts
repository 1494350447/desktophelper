import { basename, extname } from "node:path";
import { stat, readFile } from "node:fs/promises";
import { chunkText } from "../shared/chunker.ts";
import { createId } from "../shared/ids.ts";
import type {
  AppSettings,
  KbSummary,
  KnowledgeBase,
  KnowledgeChunk,
  KnowledgeDoc,
} from "../shared/models.ts";
import { AppError } from "../shared/result.ts";
import { searchChunks, type ScoredChunk } from "../shared/bm25.ts";

const TEXT_EXTENSIONS = new Set([".md", ".txt", ".markdown", ".json", ".csv", ".log", ".html", ".htm", ".ts", ".js", ".py"]);
export const MAX_DOCS = 200;
export const MAX_CHUNKS = 8000;

export function isSupportedFile(file: string): boolean {
  return TEXT_EXTENSIONS.has(extname(file).toLowerCase());
}

export function decodeTextBuffer(buffer: Buffer): string {
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return new TextDecoder("utf-16le").decode(buffer.subarray(2));
  }
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    return new TextDecoder("utf-16be").decode(buffer.subarray(2));
  }
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return buffer.subarray(3).toString("utf8");
  }
  return buffer.toString("utf8");
}

function stripHtml(input: string): string {
  return input
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

export function prepareDocumentText(name: string, rawText: string): string {
  const extension = extname(name).toLowerCase();
  const text = extension === ".html" || extension === ".htm" ? stripHtml(rawText) : rawText;
  const normalized = text.replace(/\r\n?/g, "\n").trim();
  if (!normalized) throw new AppError("VALIDATION", "文件没有可索引的文本内容");
  return normalized;
}

export type ImportInput = {
  name: string;
  text: string;
  sourcePath: string;
  bytes: number;
};

export type ImportResult = {
  kb: KnowledgeBase;
  doc: KnowledgeDoc;
  chunks: KnowledgeChunk[];
  replaced: boolean;
};

export function importTextIntoKb(kb: KnowledgeBase, input: ImportInput, settings: AppSettings, now: number): ImportResult {
  if (input.bytes > settings.kb.maxFileBytes) {
    throw new AppError("LIMIT", `文件超过 ${Math.round(settings.kb.maxFileBytes / 1000)}KB 限制`);
  }
  const prepared = prepareDocumentText(input.name, input.text);
  const pieces = chunkText(prepared, { size: settings.kb.chunkSize, overlap: settings.kb.chunkOverlap });
  if (pieces.length === 0) throw new AppError("VALIDATION", "文件没有可索引的文本内容");

  const replaced = kb.docs.some((doc) => doc.sourcePath === input.sourcePath && input.sourcePath !== "");
  let docs = replaced
    ? kb.docs.filter((doc) => !(doc.sourcePath === input.sourcePath && input.sourcePath !== ""))
    : [...kb.docs];
  let chunks = replaced
    ? kb.chunks.filter((chunk) => docs.some((doc) => doc.id === chunk.docId))
    : [...kb.chunks];

  if (docs.length >= MAX_DOCS) throw new AppError("LIMIT", `知识库最多 ${MAX_DOCS} 个文档`);
  if (chunks.length + pieces.length > MAX_CHUNKS) throw new AppError("LIMIT", `知识库最多 ${MAX_CHUNKS} 个切片`);

  const docId = createId("doc", { now });
  const doc: KnowledgeDoc = {
    id: docId,
    name: input.name || "未命名文档",
    sourcePath: input.sourcePath,
    bytes: input.bytes,
    chunks: pieces.length,
    createdAt: now,
  };
  const newChunks: KnowledgeChunk[] = pieces.map((text, index) => ({
    id: `${docId}_${index}`,
    docId,
    docName: doc.name,
    index,
    text,
  }));
  docs = [doc, ...docs];
  chunks = [...chunks, ...newChunks];
  return { kb: { version: 1, docs, chunks }, doc, chunks: newChunks, replaced };
}

export function removeDocFromKb(kb: KnowledgeBase, docId: string): KnowledgeBase {
  if (!kb.docs.some((doc) => doc.id === docId)) return kb;
  const docs = kb.docs.filter((doc) => doc.id !== docId);
  return { version: 1, docs, chunks: kb.chunks.filter((chunk) => chunk.docId !== docId) };
}

export function summarizeKb(kb: KnowledgeBase): KbSummary {
  return { docCount: kb.docs.length, chunkCount: kb.chunks.length, docs: kb.docs };
}

export function searchKb(kb: KnowledgeBase, query: string, topK: number): ScoredChunk[] {
  return searchChunks(kb.chunks, query, topK);
}

export async function readKnowledgeFile(file: string, maxBytes: number): Promise<ImportInput> {
  if (!isSupportedFile(file)) {
    throw new AppError("UNSUPPORTED", `不支持的文档类型：${extname(file) || "未知"}`);
  }
  const info = await stat(file);
  if (!info.isFile()) throw new AppError("VALIDATION", "只能导入文件");
  if (info.size > maxBytes) throw new AppError("LIMIT", `文件超过 ${Math.round(maxBytes / 1000)}KB 限制`);
  const buffer = await readFile(file);
  return {
    name: basename(file),
    text: decodeTextBuffer(buffer),
    sourcePath: file,
    bytes: info.size,
  };
}