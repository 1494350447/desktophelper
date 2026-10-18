import type { Session, TranscriptSegment } from "../src/shared/models.ts";
import { emptySession } from "../src/shared/models.ts";

export function sessionAt(now = 1_000_000): Session {
  return emptySession("s_test", now);
}

export function segmentAt(text: string, overrides: Partial<TranscriptSegment> = {}): TranscriptSegment {
  return {
    id: overrides.id ?? `seg_${Math.random().toString(36).slice(2, 8)}`,
    speaker: "interviewer",
    text,
    source: "system",
    startMs: 0,
    endMs: 1000,
    final: true,
    createdAt: 1_000_000,
    ...overrides,
  };
}