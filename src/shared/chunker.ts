export type ChunkOptions = {
  size: number;
  overlap: number;
};

function splitSentences(paragraph: string): string[] {
  const parts = paragraph.split(/(?<=[。！？!?；;])|\n+/u);
  return parts.map((part) => part.trim()).filter(Boolean);
}

function hardSplit(text: string, size: number, overlap: number): string[] {
  const pieces: string[] = [];
  let cursor = 0;
  const step = Math.max(1, size - overlap);
  while (cursor < text.length) {
    pieces.push(text.slice(cursor, cursor + size));
    cursor += step;
    if (pieces.length > 10000) break;
  }
  return pieces;
}

export function chunkText(input: string, options: ChunkOptions): string[] {
  const size = Math.max(80, Math.floor(options.size));
  const overlap = Math.max(0, Math.min(Math.floor(options.overlap), Math.floor(size / 2)));
  const normalized = input.replace(/\r\n?/g, "\n").replace(/[ \t]+/g, " ").trim();
  if (!normalized) return [];

  const seenParagraphs = new Set<string>();
  const paragraphs = normalized.split(/\n{2,}/).map((part) => part.trim()).filter((part) => {
    if (!part || seenParagraphs.has(part)) return false;
    seenParagraphs.add(part);
    return true;
  });
  const pieces: string[] = [];
  for (const paragraph of paragraphs) {
    if (paragraph.length <= size) {
      pieces.push(paragraph);
      continue;
    }
    for (const sentence of splitSentences(paragraph)) {
      if (sentence.length <= size) pieces.push(sentence);
      else pieces.push(...hardSplit(sentence, size, overlap));
    }
  }

  const chunks: string[] = [];
  let current = "";
  const flush = () => {
    const value = current.trim();
    if (value) chunks.push(value);
    current = overlap > 0 && value.length > overlap ? value.slice(-overlap) : "";
  };

  for (const piece of pieces) {
    if (!current) {
      current = piece;
      continue;
    }
    if (current.length + 1 + piece.length <= size) {
      current = `${current}\n${piece}`;
      continue;
    }
    flush();
    if (current && current.length + 1 + piece.length <= size) {
      current = `${current}\n${piece}`;
    } else {
      current = piece;
    }
  }
  const tail = current.trim();
  if (tail && tail !== chunks[chunks.length - 1]) chunks.push(tail);
  return chunks;
}