import type { AppSettings, Session, Speaker, TranscriptSegment } from "./models.ts";
import { countChars, looksLikeQuestion, normalizeForCompare, normalizeWhitespace } from "./text.ts";

export type TriggerAction = "answer" | "queue" | "ignore";

export type TriggerDecision = {
  action: TriggerAction;
  reason: string;
  question?: string;
  normalized?: string;
};

function speakerMatches(target: AppSettings["trigger"]["targetSpeaker"], speaker: Speaker): boolean {
  if (target === "both") return true;
  return target === speaker;
}

export function evaluateSegment(
  session: Session,
  segment: TranscriptSegment,
  settings: AppSettings,
  now: number,
): TriggerDecision {
  if (!segment.final) return { action: "ignore", reason: "not-final" };
  const question = normalizeWhitespace(segment.text);
  const chars = countChars(question);
  if (!question) return { action: "ignore", reason: "empty" };
  if (!speakerMatches(settings.trigger.targetSpeaker, segment.speaker)) {
    return { action: "ignore", reason: "speaker-mismatch" };
  }
  if (chars < settings.trigger.minChars) return { action: "ignore", reason: "too-short" };

  const normalized = normalizeForCompare(question);
  if (!normalized) return { action: "ignore", reason: "empty" };

  const dedupeWindow = settings.trigger.dedupeWindowMs;
  const recentDuplicate = session.recentTriggers.some(
    (entry) => entry.normalized === normalized && now - entry.at <= dedupeWindow,
  );
  if (recentDuplicate) return { action: "ignore", reason: "duplicate" };

  const lastSegments = session.segments.slice(-4);
  if (lastSegments.some((entry) => normalizeForCompare(entry.text) === normalized)) {
    return { action: "ignore", reason: "duplicate-segment" };
  }
  if (session.queue.some((entry) => normalizeForCompare(entry.text) === normalized)) {
    return { action: "ignore", reason: "already-queued" };
  }

  if (!settings.trigger.autoAnswer) return { action: "ignore", reason: "auto-disabled" };

  const payload = { question, normalized };
  if (session.inflightAnswerId) return { action: "queue", reason: "busy", ...payload };

  if (session.lastTriggerAt !== null && now - session.lastTriggerAt < settings.trigger.throttleMs) {
    return { action: "queue", reason: "throttled", ...payload };
  }

  return {
    action: "answer",
    reason: looksLikeQuestion(question) ? "question" : "statement",
    ...payload,
  };
}

export function shouldTriggerManually(text: string, minChars: number): TriggerDecision {
  const question = normalizeWhitespace(text);
  if (!question) return { action: "ignore", reason: "empty" };
  if (countChars(question) === 0) return { action: "ignore", reason: "too-short" };
  return {
    action: "answer",
    reason: "manual",
    question,
    normalized: normalizeForCompare(question),
  };
}