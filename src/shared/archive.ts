import type { ScreenshotMeta } from "./models.ts";

export type ArchiveGuard = {
  requestId: string;
  screenshotContextId: string;
  archiveRequestId: string;
};

export type ArchiveCheck =
  | { ok: true }
  | { ok: false; reason: "request-mismatch" | "context-mismatch" | "archive-mismatch" | "already-archived" };

export function checkArchiveGuard(
  screenshot: Pick<ScreenshotMeta, "requestId" | "screenshotContextId" | "archiveRequestId" | "archiveState">,
  guard: ArchiveGuard,
): ArchiveCheck {
  if (screenshot.requestId !== guard.requestId) return { ok: false, reason: "request-mismatch" };
  if (screenshot.screenshotContextId !== guard.screenshotContextId) return { ok: false, reason: "context-mismatch" };
  if (screenshot.archiveRequestId !== guard.archiveRequestId) return { ok: false, reason: "archive-mismatch" };
  if (screenshot.archiveState === "archived") return { ok: false, reason: "already-archived" };
  return { ok: true };
}

export function archiveRetryDelay(attempt: number): number {
  const clamped = Math.max(0, Math.min(attempt, 6));
  return Math.min(30000, 500 * 2 ** clamped);
}