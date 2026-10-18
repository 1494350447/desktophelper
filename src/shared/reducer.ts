import type { Answer, AnswerLane, QueuedQuestion, Session, Speaker, TranscriptSegment } from "./models.ts";

export type SessionEvent =
  | { type: "session.rename"; title: string; now: number }
  | { type: "segment.append"; segment: TranscriptSegment; now: number; maxSegments?: number }
  | { type: "segment.remove"; id: string; now: number }
  | { type: "segment.speaker"; id: string; speaker: Speaker; now: number }
  | { type: "segments.clear"; now: number }
  | { type: "answer.start"; answer: Answer; now: number }
  | { type: "answer.delta"; answerId: string; generationId: number; delta: string; now: number }
  | { type: "answer.reset"; answerId: string; generationId: number; now: number }
  | {
      type: "answer.done";
      answerId: string;
      generationId: number;
      now: number;
      model?: string;
      citedDocs?: string[];
    }
  | { type: "answer.fail"; answerId: string; generationId: number; now: number; message: string }
  | { type: "answer.cancel"; answerId: string; generationId: number; now: number }
  | { type: "queue.push"; question: QueuedQuestion; now: number }
  | { type: "queue.remove"; id: string; now: number }
  | { type: "queue.clear"; now: number }
  | { type: "inflight.clear"; answerId: string; now: number }
  | { type: "trigger.mark"; normalized: string; now: number; keep?: number }
  | { type: "answers.trim"; max: number; now: number };

const DEFAULT_SEGMENT_CAP = 4000;
const DEFAULT_TRIGGER_CAP = 24;

function withUpdate(session: Session, now: number, patch: Partial<Session>): Session {
  return { ...session, ...patch, updatedAt: now };
}

function findAnswer(session: Session, answerId: string): Answer | undefined {
  return session.answers.find((answer) => answer.id === answerId);
}

function laneOf(answer: Answer): AnswerLane {
  if (answer.lane) return answer.lane;
  return answer.trigger === "screenshot" ? "screenshot" : "voice";
}

function clearedInflight(session: Session, answerId: string): Partial<Session> {
  const answer = findAnswer(session, answerId);
  const lane = answer
    ? laneOf(answer)
    : session.inflightScreenshotAnswerId === answerId
      ? "screenshot"
      : "voice";
  if (lane === "screenshot") {
    if (session.inflightScreenshotAnswerId !== answerId) return {};
    return { inflightScreenshotAnswerId: null, inflightScreenshotQuestion: null };
  }
  if (session.inflightAnswerId !== answerId) return {};
  return { inflightAnswerId: null, inflightQuestion: null };
}

function replaceAnswer(session: Session, next: Answer): Session {
  return {
    ...session,
    answers: session.answers.map((answer) => (answer.id === next.id ? next : answer)),
  };
}

export function reduceSession(session: Session, event: SessionEvent): Session {
  switch (event.type) {
    case "session.rename": {
      const title = event.title.trim();
      if (!title || title === session.title) return session;
      return withUpdate(session, event.now, { title });
    }
    case "segment.append": {
      const cap = event.maxSegments ?? DEFAULT_SEGMENT_CAP;
      const segments = [...session.segments, event.segment].slice(-cap);
      return withUpdate(session, event.now, { segments });
    }
    case "segment.remove": {
      if (!session.segments.some((segment) => segment.id === event.id)) return session;
      return withUpdate(session, event.now, {
        segments: session.segments.filter((segment) => segment.id !== event.id),
      });
    }
    case "segment.speaker": {
      const target = session.segments.find((segment) => segment.id === event.id);
      if (!target || target.speaker === event.speaker) return session;
      const segments = session.segments.map((segment) =>
        segment.id === event.id ? { ...segment, speaker: event.speaker } : segment,
      );
      return withUpdate(session, event.now, { segments });
    }
    case "segments.clear": {
      if (session.segments.length === 0) return session;
      return withUpdate(session, event.now, { segments: [] });
    }
    case "answer.start": {
      if (findAnswer(session, event.answer.id)) return session;
      const lane = laneOf(event.answer);
      const inflight =
        lane === "screenshot"
          ? {
              inflightScreenshotAnswerId: event.answer.id,
              inflightScreenshotQuestion: event.answer.question,
            }
          : {
              inflightAnswerId: event.answer.id,
              inflightQuestion: event.answer.question,
            };
      return withUpdate(session, event.now, {
        answers: [...session.answers, event.answer],
        ...inflight,
      });
    }
    case "answer.delta": {
      const answer = findAnswer(session, event.answerId);
      if (!answer || answer.generationId !== event.generationId) return session;
      if (answer.status !== "streaming") return session;
      const next: Answer = {
        ...answer,
        text: answer.text + event.delta,
        updatedAt: event.now,
      };
      const updated = replaceAnswer(session, next);
      return withUpdate(updated, event.now, {});
    }
    case "answer.reset": {
      const answer = findAnswer(session, event.answerId);
      if (!answer || answer.generationId !== event.generationId) return session;
      if (answer.status !== "streaming" || answer.text === "") return session;
      return withUpdate(replaceAnswer(session, { ...answer, text: "", updatedAt: event.now }), event.now, {});
    }
    case "answer.done": {
      const answer = findAnswer(session, event.answerId);
      if (!answer || answer.generationId !== event.generationId) return session;
      if (answer.status !== "streaming") return session;
      const next: Answer = {
        ...answer,
        status: "done",
        updatedAt: event.now,
        ...(event.model ? { model: event.model } : {}),
        ...(event.citedDocs ? { citedDocs: event.citedDocs } : {}),
      };
      const updated = replaceAnswer(session, next);
      return withUpdate(updated, event.now, {
        ...clearedInflight(session, event.answerId),
      });
    }
    case "answer.fail": {
      const answer = findAnswer(session, event.answerId);
      if (!answer || answer.generationId !== event.generationId) return session;
      if (answer.status !== "streaming") return session;
      const next: Answer = {
        ...answer,
        status: "error",
        error: event.message,
        updatedAt: event.now,
      };
      const updated = replaceAnswer(session, next);
      return withUpdate(updated, event.now, {
        ...clearedInflight(session, event.answerId),
      });
    }
    case "answer.cancel": {
      const answer = findAnswer(session, event.answerId);
      if (!answer || answer.generationId !== event.generationId) return session;
      if (answer.status !== "streaming") return session;
      const next: Answer = {
        ...answer,
        status: "cancelled",
        updatedAt: event.now,
      };
      const updated = replaceAnswer(session, next);
      return withUpdate(updated, event.now, {
        ...clearedInflight(session, event.answerId),
      });
    }
    case "queue.push": {
      if (session.queue.some((entry) => entry.id === event.question.id)) return session;
      return withUpdate(session, event.now, { queue: [...session.queue, event.question] });
    }
    case "queue.remove": {
      if (!session.queue.some((entry) => entry.id === event.id)) return session;
      return withUpdate(session, event.now, {
        queue: session.queue.filter((entry) => entry.id !== event.id),
      });
    }
    case "queue.clear": {
      if (session.queue.length === 0) return session;
      return withUpdate(session, event.now, { queue: [] });
    }
    case "inflight.clear": {
      const patch = clearedInflight(session, event.answerId);
      if (Object.keys(patch).length === 0) return session;
      return withUpdate(session, event.now, patch);
    }
    case "trigger.mark": {
      const keep = event.keep ?? DEFAULT_TRIGGER_CAP;
      const recentTriggers = [...session.recentTriggers, { normalized: event.normalized, at: event.now }].slice(-keep);
      return withUpdate(session, event.now, { lastTriggerAt: event.now, recentTriggers });
    }
    case "answers.trim": {
      const max = Math.max(1, event.max);
      if (session.answers.length <= max) return session;
      const removable = session.answers.filter((answer) => answer.status !== "streaming");
      const overflow = session.answers.length - max;
      if (overflow <= 0 || removable.length === 0) return session;
      const dropIds = new Set(removable.slice(0, overflow).map((answer) => answer.id));
      return withUpdate(session, event.now, {
        answers: session.answers.filter((answer) => !dropIds.has(answer.id)),
      });
    }
    default: {
      return session;
    }
  }
}

export function applyEvents(session: Session, events: SessionEvent[]): Session {
  return events.reduce(reduceSession, session);
}
