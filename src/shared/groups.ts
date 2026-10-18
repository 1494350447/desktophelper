import type { CaptureGroup } from "./models.ts";

export const GROUP_IDLE_MS = 10 * 60_000;

export type GroupEvent =
  | { type: "group.append"; shotId: string; now: number }
  | { type: "group.answering"; answerId: string; shotCount: number; now: number }
  | { type: "group.answered"; answerId: string; now: number }
  | { type: "group.error"; answerId?: string; message: string; now: number }
  | { type: "group.cancel"; now: number }
  | { type: "group.reopen"; now: number }
  | { type: "group.close"; now: number };

export function createCaptureGroup(params: {
  id: string;
  seq: number;
  sessionId: string;
  screenshotId: string;
  now: number;
}): CaptureGroup {
  return {
    id: params.id,
    seq: params.seq,
    sessionId: params.sessionId,
    createdAt: params.now,
    updatedAt: params.now,
    status: "collecting",
    screenshotIds: [params.screenshotId],
    answerId: null,
    answerIds: [],
  };
}

export function nextGroupSeq(groups: CaptureGroup[]): number {
  return groups.reduce((max, group) => Math.max(max, group.seq), 0) + 1;
}

export function reduceGroup(group: CaptureGroup, event: GroupEvent): CaptureGroup {
  switch (event.type) {
    case "group.append": {
      if (group.screenshotIds.includes(event.shotId)) return group;
      const screenshotIds = [...group.screenshotIds, event.shotId];
      const status = group.status === "answering" ? "answering" : "collecting";
      return {
        ...group,
        screenshotIds,
        status,
        updatedAt: event.now,
        ...(status === "collecting" ? { lastError: undefined } : {}),
      };
    }
    case "group.answering": {
      const answerIds = group.answerIds.includes(event.answerId)
        ? group.answerIds
        : [...group.answerIds, event.answerId];
      return {
        ...group,
        status: "answering",
        answerId: event.answerId,
        answerIds,
        solvedShotCount: Math.max(0, Math.min(event.shotCount, group.screenshotIds.length)),
        updatedAt: event.now,
        lastError: undefined,
      };
    }
    case "group.answered": {
      if (group.answerId && group.answerId !== event.answerId) return group;
      return {
        ...group,
        status: "answered",
        answerId: event.answerId,
        updatedAt: event.now,
        lastError: undefined,
      };
    }
    case "group.error": {
      if (event.answerId && group.answerId && group.answerId !== event.answerId) return group;
      return {
        ...group,
        status: "error",
        answerId: event.answerId ?? group.answerId,
        updatedAt: event.now,
        lastError: event.message,
      };
    }
    case "group.cancel": {
      return {
        ...group,
        status: "collecting",
        updatedAt: event.now,
        lastError: undefined,
      };
    }
    case "group.reopen": {
      if (group.status === "answering") return group;
      return { ...group, status: "collecting", updatedAt: event.now, lastError: undefined };
    }
    case "group.close": {
      if (group.status === "answering") return group;
      return { ...group, status: "closed", updatedAt: event.now };
    }
    default:
      return group;
  }
}

export function pickCaptureGroup(
  groups: CaptureGroup[],
  now: number,
  idleMs = GROUP_IDLE_MS,
): CaptureGroup | null {
  const last = groups.at(-1);
  if (!last) return null;
  if (last.status !== "collecting" && last.status !== "error") return null;
  if (now - last.updatedAt > idleMs) return null;
  return last;
}

export function findGroupByShot(groups: CaptureGroup[], shotId: string): CaptureGroup | null {
  return groups.find((group) => group.screenshotIds.includes(shotId)) ?? null;
}

export function pendingShotCount(group: CaptureGroup): number {
  if (!group.answerId) return group.screenshotIds.length;
  const solved = group.solvedShotCount ?? 0;
  return Math.max(0, group.screenshotIds.length - solved);
}

export function canAppendToGroup(group: CaptureGroup): boolean {
  return group.status === "collecting" || group.status === "error";
}
