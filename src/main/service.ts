import { join } from "node:path";
import type {
  Answer,
  AnswerLane,
  AppSettings,
  AppSnapshot,
  CaptureGroup,
  ExtractedProblem,
  KnowledgeBase,
  ListeningState,
  QueuedQuestion,
  ScreenshotMeta,
  ScreenshotRoute,
  ScreenshotStage,
  ScreenshotStrategy,
  Session,
  Speaker,
  TranscriptSegment,
} from "../shared/models.ts";
import {
  defaultSettings,
  emptyKnowledgeBase,
  emptySession,
  summarizeSession,
} from "../shared/models.ts";
import type { SessionEvent } from "../shared/reducer.ts";
import { reduceSession } from "../shared/reducer.ts";
import {
  GROUP_IDLE_MS,
  canAppendToGroup,
  createCaptureGroup,
  nextGroupSeq,
  pickCaptureGroup,
  reduceGroup,
} from "../shared/groups.ts";
import type { GroupEvent } from "../shared/groups.ts";
import { evaluateSegment, shouldTriggerManually } from "../shared/trigger.ts";
import type { TriggerDecision } from "../shared/trigger.ts";
import {
  buildAnswerMessages,
  buildExtractionPrompt,
  buildSolutionMessages,
  buildTranscriptWindow,
  buildVisionSolutionPrompt,
} from "../shared/prompt.ts";
import {
  buildContinuationContext,
  chooseScreenshotStrategy,
  mergeExtractedProblems,
  parseExtractedProblem,
  screenshotQuestion,
  shouldFallbackToExtract,
} from "../shared/screenshot.ts";
import { intervalOverlapRatio, isLikelySameUtterance, normalizeForCompare, textSimilarity } from "../shared/text.ts";
import { createId } from "../shared/ids.ts";
import { AppError } from "../shared/result.ts";
import type { EventName, ServerEvents } from "../shared/protocol.ts";
import { settingsSchema } from "../shared/protocol.ts";
import { S } from "../shared/schema.ts";
import { archiveRetryDelay, checkArchiveGuard, type ArchiveGuard } from "../shared/archive.ts";
import { normalizeHotkeySettings } from "../shared/hotkeys.ts";
import { readJsonFile, writeJsonAtomic } from "./json-file.ts";
import type { Logger } from "./logger.ts";
import type { SecretsStore } from "./secrets.ts";
import { summarizeKb, importTextIntoKb, readKnowledgeFile, removeDocFromKb, searchKb } from "./knowledge.ts";
import type { ImportInput } from "./knowledge.ts";
import {
  analyzeImagesStream,
  asChatMessage,
  extractProblemFromImages,
  streamChat,
  testProvider,
  transcribeAudio,
} from "./providers.ts";
import {
  DashScopeRealtimeSession,
  normalizeDashScopeLanguage,
  resolveDashScopeUrl,
  type DashScopeSessionOptions,
  type RealtimeFinalResult,
  type RealtimeTranscriptionSession,
} from "./dashscope.ts";

export type OverlayBridge = {
  apply: (settings: AppSettings) => void;
  toggle: () => boolean;
  setClickThrough: (value: boolean) => void;
  setInteraction: (active: boolean) => void;
  drag: (phase: "start" | "move" | "end", dx?: number, dy?: number) => void;
  move: (dx: number, dy: number) => void;
  resize: (size: { width: number; height: number }) => void;
  openRegionSelector: () => Promise<boolean>;
  closeRegionSelector: () => boolean;
};

export type HotkeyBridge = {
  apply: (settings: AppSettings) => void;
};

export type ServiceAdapters = {
  pickFiles?: (multiple: boolean) => Promise<string[]>;
  archiveDelayMs?: (attempt: number) => number;
  createRealtimeSession?: (options: DashScopeSessionOptions) => RealtimeTranscriptionSession;
};

export type ServiceOptions = {
  dataDir: string;
  outDir: string;
  appVersion: string;
  logger: Logger;
  secrets: SecretsStore;
  adapters?: ServiceAdapters;
  now?: () => number;
};

type SessionsFile = { version: 1; sessions: Session[]; currentId: string | null };
type ScreenshotsFile = { version: 2; items: ScreenshotMeta[]; groups: CaptureGroup[] };
type LegacyScreenshotsFile = { version: 1; items: ScreenshotMeta[] };

type AnswerOptions = {
  lane?: AnswerLane;
  screenshotId?: string;
  screenshotIds?: string[];
  groupId?: string;
  note?: string;
  plan?: ScreenshotPlan;
};

type ScreenshotPlan = {
  route: ScreenshotRoute;
  images: string[];
  note?: string;
  extraction?: ExtractedProblem;
  previousProblem?: string;
  previousAnswer?: string;
  continuation?: boolean;
};

type ActiveGeneration = { controller: AbortController; generationId: number; sessionId: string };

const MAX_SESSIONS = 60;
const MAX_SCREENSHOTS = 60;

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolveSleep, rejectSleep) => {
    if (signal?.aborted) {
      const error = new Error("aborted");
      error.name = "AbortError";
      rejectSleep(error);
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolveSleep();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      const error = new Error("aborted");
      error.name = "AbortError";
      rejectSleep(error);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function deepMerge<T>(base: T, patch: unknown): T {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) return base;
  if (!base || typeof base !== "object" || Array.isArray(base)) return patch as T;
  const result: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
    const current = result[key];
    if (current && typeof current === "object" && !Array.isArray(current) && value && typeof value === "object" && !Array.isArray(value)) {
      result[key] = deepMerge(current, value);
    } else if (value !== undefined) {
      result[key] = value;
    }
  }
  return result as T;
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function stripLegacySettings(raw: unknown): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const { mobile: _mobile, ...rest } = raw as Record<string, unknown>;
  return rest;
}

const SETTINGS_VERSION = 5;

function migrateSettings(settings: AppSettings, sourceVersion: number): AppSettings {
  const upgraded = sourceVersion >= SETTINGS_VERSION
    ? settings
    : {
        ...settings,
        trigger: { ...settings.trigger, autoAnswer: true },
        overlay: {
          ...settings.overlay,
          clickThrough: true,
          compact: sourceVersion < 4 ? true : settings.overlay.compact,
          bounds:
            sourceVersion < 4 && settings.overlay.bounds && settings.overlay.bounds.width > 620
              ? null
              : settings.overlay.bounds,
          ...(sourceVersion < 5 && Math.abs(settings.overlay.opacity - 0.92) < 0.001
            ? { opacity: 0.86 }
            : {}),
        },
      };
  return {
    ...upgraded,
    version: Math.max(sourceVersion, SETTINGS_VERSION),
    trigger: { ...upgraded.trigger, autoAnswer: true },
  };
}

function forceRequiredDefaults(settings: AppSettings): AppSettings {
  return {
    ...settings,
    trigger: { ...settings.trigger, autoAnswer: true },
    overlay: { ...settings.overlay, clickThrough: true },
  };
}

function normalizeSettings(raw: unknown): AppSettings {
  const cleaned = stripLegacySettings(raw);
  const merged = deepMerge(defaultSettings(), cleaned);
  try {
    const sourceVersion =
      cleaned && typeof cleaned === "object" && typeof (cleaned as Record<string, unknown>).version === "number"
        ? Number((cleaned as Record<string, unknown>).version)
        : 1;
    const validated = forceRequiredDefaults(S.validate(settingsSchema, migrateSettings(merged, sourceVersion)));
    return { ...validated, hotkeys: normalizeHotkeySettings(validated.hotkeys) };
  } catch {
    return defaultSettings();
  }
}

function normalizeSegment(raw: unknown): TranscriptSegment | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  if (typeof value.id !== "string" || typeof value.text !== "string") return null;
  const speaker: Speaker = value.speaker === "me" ? "me" : "interviewer";
  const source = value.source === "mic" || value.source === "system" || value.source === "manual" ? value.source : "manual";
  return {
    id: value.id,
    speaker,
    text: value.text,
    source,
    startMs: numberOr(value.startMs, 0),
    endMs: numberOr(value.endMs, 0),
    final: value.final !== false,
    createdAt: numberOr(value.createdAt, Date.now()),
  };
}

function normalizeAnswer(raw: unknown): Answer | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  if (typeof value.id !== "string" || typeof value.question !== "string") return null;
  const statuses = ["streaming", "done", "error", "cancelled"];
  const triggers = ["auto", "manual", "queue", "screenshot", "knowledge"];
  const status = statuses.includes(String(value.status)) ? (value.status as Answer["status"]) : "error";
  const trigger = triggers.includes(String(value.trigger)) ? (value.trigger as Answer["trigger"]) : "manual";
  const lane: AnswerLane = value.lane === "screenshot" || trigger === "screenshot" ? "screenshot" : "voice";
  return {
    id: value.id,
    generationId: numberOr(value.generationId, 0),
    question: value.question,
    trigger,
    lane,
    status: status === "streaming" ? "error" : status,
    text: typeof value.text === "string" ? value.text : "",
    ...(typeof value.error === "string" ? { error: value.error } : status === "streaming" ? { error: "应用重启，回答已中断" } : {}),
    ...(typeof value.model === "string" ? { model: value.model } : {}),
    ...(Array.isArray(value.citedDocs) ? { citedDocs: value.citedDocs.filter((item): item is string => typeof item === "string") } : {}),
    ...(typeof value.screenshotId === "string" ? { screenshotId: value.screenshotId } : {}),
    ...(typeof value.groupId === "string" ? { groupId: value.groupId } : {}),
    ...(Array.isArray(value.screenshotIds)
      ? { screenshotIds: value.screenshotIds.filter((item): item is string => typeof item === "string") }
      : {}),
    createdAt: numberOr(value.createdAt, Date.now()),
    updatedAt: numberOr(value.updatedAt, Date.now()),
  };
}

function normalizeSession(raw: unknown): Session | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  if (typeof value.id !== "string") return null;
  const now = Date.now();
  const segments = Array.isArray(value.segments)
    ? value.segments.map(normalizeSegment).filter((item): item is TranscriptSegment => Boolean(item)).slice(-4000)
    : [];
  const answers = Array.isArray(value.answers)
    ? value.answers.map(normalizeAnswer).filter((item): item is Answer => Boolean(item)).slice(-50)
    : [];
  const queue = Array.isArray(value.queue)
    ? value.queue
        .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
        .map((item) => ({
          id: typeof item.id === "string" ? item.id : createId("q"),
          speaker: item.speaker === "me" ? ("me" as const) : ("interviewer" as const),
          text: typeof item.text === "string" ? item.text : "",
          createdAt: numberOr(item.createdAt, now),
          reason: typeof item.reason === "string" ? item.reason : "restored",
          lane: item.lane === "screenshot" ? ("screenshot" as const) : ("voice" as const),
        }))
        .filter((item) => item.text)
    : [];
  return {
    ...emptySession(value.id, numberOr(value.createdAt, now)),
    title: typeof value.title === "string" && value.title.trim() ? value.title : "新的会话",
    createdAt: numberOr(value.createdAt, now),
    updatedAt: numberOr(value.updatedAt, now),
    segments,
    answers,
    queue,
    inflightAnswerId: null,
    inflightQuestion: null,
    inflightScreenshotAnswerId: null,
    inflightScreenshotQuestion: null,
    lastTriggerAt: typeof value.lastTriggerAt === "number" ? value.lastTriggerAt : null,
    recentTriggers: Array.isArray(value.recentTriggers)
      ? value.recentTriggers
          .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
          .map((item) => ({ normalized: String(item.normalized ?? ""), at: numberOr(item.at, now) }))
          .filter((item) => item.normalized)
          .slice(-24)
      : [],
    archived: Boolean(value.archived),
  };
}

function normalizeScreenshot(raw: unknown): ScreenshotMeta | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  if (typeof value.id !== "string" || typeof value.file !== "string") return null;
  const state = value.archiveState;
  const analysis =
    value.analysis && typeof value.analysis === "object"
      ? (value.analysis as ScreenshotMeta["analysis"])
      : ({ status: "idle" } as ScreenshotMeta["analysis"]);
  const recovered =
    analysis.status === "streaming"
      ? {
          ...analysis,
          status: "error" as const,
          stage: "error" as const,
          error: "应用重启，分析已中断，请重新点击解题",
          updatedAt: Date.now(),
        }
      : analysis;
  return {
    id: value.id,
    createdAt: numberOr(value.createdAt, Date.now()),
    mode: value.mode === "region" ? "region" : "full",
    width: numberOr(value.width, 0),
    height: numberOr(value.height, 0),
    file: value.file,
    displayId: typeof value.displayId === "string" ? value.displayId : "0",
    requestId: typeof value.requestId === "string" ? value.requestId : createId("req"),
    screenshotContextId: typeof value.screenshotContextId === "string" ? value.screenshotContextId : createId("ctx"),
    archiveRequestId: typeof value.archiveRequestId === "string" ? value.archiveRequestId : createId("arc"),
    archiveState: state === "archived" || state === "failed" ? state : "pending",
    archiveAttempts: numberOr(value.archiveAttempts, 0),
    ...(typeof value.archiveError === "string" ? { archiveError: value.archiveError } : {}),
    ...(typeof value.archivedPath === "string" ? { archivedPath: value.archivedPath } : {}),
    analysis: recovered,
  };
}

const GROUP_STATUSES: CaptureGroup["status"][] = ["collecting", "answering", "answered", "error", "closed"];

function normalizeGroup(raw: unknown, fallbackSessionId: string): CaptureGroup | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  if (typeof value.id !== "string" || !value.id) return null;
  const screenshotIds = Array.isArray(value.screenshotIds)
    ? value.screenshotIds.filter((id): id is string => typeof id === "string")
    : [];
  if (screenshotIds.length === 0) return null;
  const requested = typeof value.status === "string" ? value.status : "closed";
  let status = GROUP_STATUSES.includes(requested as CaptureGroup["status"])
    ? (requested as CaptureGroup["status"])
    : "closed";
  let lastError = typeof value.lastError === "string" ? value.lastError : undefined;
  if (status === "answering") {
    status = "error";
    lastError = "应用重启，解题已中断，请点击重试";
  }
  const answerIds = Array.isArray(value.answerIds)
    ? value.answerIds.filter((id): id is string => typeof id === "string")
    : [];
  const createdAt = numberOr(value.createdAt, Date.now());
  return {
    id: value.id,
    seq: Math.max(1, Math.round(numberOr(value.seq, 1))),
    sessionId: typeof value.sessionId === "string" ? value.sessionId : fallbackSessionId,
    createdAt,
    updatedAt: numberOr(value.updatedAt, createdAt),
    status,
    screenshotIds,
    answerId: typeof value.answerId === "string" ? value.answerId : null,
    answerIds,
    ...(typeof value.solvedShotCount === "number"
      ? { solvedShotCount: Math.max(0, Math.round(value.solvedShotCount)) }
      : {}),
    ...(lastError ? { lastError } : {}),
  };
}

function normalizeKb(raw: unknown): KnowledgeBase {
  if (!raw || typeof raw !== "object") return emptyKnowledgeBase();
  const value = raw as Record<string, unknown>;
  const docs = Array.isArray(value.docs)
    ? value.docs.filter((item): item is KnowledgeBase["docs"][number] => Boolean(item) && typeof item === "object")
    : [];
  const chunks = Array.isArray(value.chunks)
    ? value.chunks.filter((item): item is KnowledgeBase["chunks"][number] => Boolean(item) && typeof item === "object")
    : [];
  return { version: 1, docs, chunks };
}

function toAudioBuffer(data: unknown): Buffer {
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  if (Buffer.isBuffer(data)) return data;
  throw new AppError("VALIDATION", "音频数据格式不正确");
}

export class AppService {
  readonly dataDir: string;
  readonly outDir: string;
  readonly appVersion: string;
  readonly logger: Logger;
  readonly secrets: SecretsStore;
  readonly adapters: ServiceAdapters;
  private readonly nowFn: () => number;

  settings: AppSettings = defaultSettings();
  kb: KnowledgeBase = emptyKnowledgeBase();
  sessions: Session[] = [];
  currentId = "";
  screenshots: ScreenshotMeta[] = [];
  groups: CaptureGroup[] = [];
  listening: ListeningState = { mic: false, system: false };
  unlocked = true;
  warnings: string[] = [];

  private emitter: ((event: EventName, payload: unknown) => void) | null = null;
  private overlay: OverlayBridge | null = null;
  private hotkeys: HotkeyBridge | null = null;
  private active = new Map<string, ActiveGeneration>();
  private generationCounter = 0;
  private saveChain: Promise<void> = Promise.resolve();
  private lockFailures = 0;
  private lockBlockedUntil = 0;
  private lastOverlaySave = 0;
  private screenshotTask: { label: string; token: object } | null = null;
  private screenshotAborts = new Map<string, AbortController>();
  private preferredGroup: { id: string; at: number } | null = null;
  private realtime = new Map<"mic" | "system", RealtimeTranscriptionSession>();
  private realtimeEpoch = new Map<"mic" | "system", number>();
  private realtimeEpochCounter = 0;
  private realtimeAppends = new Set<Promise<void>>();
  private transcriptAppendChain: Promise<void> = Promise.resolve();

  constructor(options: ServiceOptions) {
    this.dataDir = options.dataDir;
    this.outDir = options.outDir;
    this.appVersion = options.appVersion;
    this.logger = options.logger;
    this.secrets = options.secrets;
    this.adapters = options.adapters ?? {};
    this.nowFn = options.now ?? (() => Date.now());
  }

  now(): number {
    return this.nowFn();
  }

  setEmitter(emitter: (event: EventName, payload: unknown) => void): void {
    this.emitter = emitter;
  }

  setOverlayBridge(bridge: OverlayBridge): void {
    this.overlay = bridge;
    bridge.apply(this.settings);
  }

  setHotkeyBridge(bridge: HotkeyBridge): void {
    this.hotkeys = bridge;
    bridge.apply(this.settings);
  }

  emit<E extends EventName>(event: E, payload: ServerEvents[E]): void {
    try {
      this.emitter?.(event, payload);
    } catch (error) {
      this.logger.warn("event emitter failed", { event, error: String(error) });
    }
  }

  async init(): Promise<void> {
    await this.logger.init();
    await this.secrets.load();
    this.settings = normalizeSettings(await readJsonFile(join(this.dataDir, "settings.json"), defaultSettings()));
    const sessionsFile = await readJsonFile<SessionsFile>(join(this.dataDir, "sessions.json"), {
      version: 1,
      sessions: [],
      currentId: null,
    });
    this.sessions = (Array.isArray(sessionsFile.sessions) ? sessionsFile.sessions : [])
      .map(normalizeSession)
      .filter((item): item is Session => Boolean(item))
      .slice(-MAX_SESSIONS);
    const requested = typeof sessionsFile.currentId === "string" ? sessionsFile.currentId : "";
    this.currentId = this.sessions.some((session) => session.id === requested) ? requested : this.sessions.at(-1)?.id ?? "";
    if (!this.currentId) {
      const session = emptySession(createId("sess", { now: this.now() }), this.now());
      this.sessions.push(session);
      this.currentId = session.id;
    }
    const shotsFile = await readJsonFile<ScreenshotsFile | LegacyScreenshotsFile>(
      join(this.dataDir, "screenshots.json"),
      { version: 2, items: [], groups: [] },
    );
    this.screenshots = (Array.isArray(shotsFile.items) ? shotsFile.items : [])
      .map(normalizeScreenshot)
      .filter((item): item is ScreenshotMeta => Boolean(item));
    const storedGroups = (shotsFile as Partial<ScreenshotsFile>).groups;
    if (Array.isArray(storedGroups)) {
      this.groups = storedGroups
        .map((raw) => normalizeGroup(raw, this.currentId))
        .filter((item): item is CaptureGroup => Boolean(item));
      this.pruneGroupsToShots();
    } else {
      this.groups = this.migrateGroups();
    }
    this.trimScreenshots();
    this.kb = normalizeKb(await readJsonFile(join(this.dataDir, "knowledge.json"), emptyKnowledgeBase()));
    this.unlocked = !(this.secrets.hasLock() && this.settings.privacy.lockEnabled);
    if (!this.secrets.encryption) {
      this.warnings.push("系统安全存储不可用，API Key 仅以本地编码保存");
    }
    await this.persist();
    this.logger.info("service initialized", { version: this.appVersion, dataDir: this.dataDir });
  }

  currentSession(): Session {
    let session = this.sessions.find((entry) => entry.id === this.currentId);
    if (!session) {
      session = emptySession(createId("sess", { now: this.now() }), this.now());
      this.sessions.push(session);
      this.currentId = session.id;
    }
    return session;
  }

  private replaceSession(next: Session): Session {
    const index = this.sessions.findIndex((entry) => entry.id === next.id);
    if (index >= 0) this.sessions[index] = next;
    else this.sessions.push(next);
    return next;
  }

  dispatch(event: SessionEvent): Session {
    return this.replaceSession(reduceSession(this.currentSession(), event));
  }

  isLocked(): boolean {
    return this.secrets.hasLock() && this.settings.privacy.lockEnabled && !this.unlocked;
  }

  snapshot(): AppSnapshot {
    const locked = this.isLocked();
    const session = locked
      ? { ...emptySession("locked", this.now()), title: "已锁定" }
      : this.currentSession();
    return {
      appVersion: this.appVersion,
      dataDir: this.dataDir,
      settings: structuredClone(this.settings),
      session,
      sessions: locked ? [] : this.sessions.map(summarizeSession),
      secrets: this.secrets.status(),
      screenshots: locked ? [] : this.screenshots.map((item) => ({ ...item })),
      groups: locked
        ? []
        : this.groups
            .filter((group) => group.sessionId === this.currentId)
            .map((group) => ({ ...group, screenshotIds: [...group.screenshotIds], answerIds: [...group.answerIds] })),
      kb: locked ? { docCount: 0, chunkCount: 0, docs: [] } : summarizeKb(this.kb),
      listening: locked ? { mic: false, system: false } : { ...this.listening },
      lock: {
        enabled: this.secrets.hasLock() && this.settings.privacy.lockEnabled,
        unlocked: this.unlocked,
      },
      warnings: [...this.warnings],
    };
  }

  pushState(): void {
    this.emit("state", this.snapshot());
  }

  persist(): Promise<void> {
    const sessionsSnapshot: SessionsFile = {
      version: 1,
      sessions: this.sessions.slice(-MAX_SESSIONS),
      currentId: this.currentId,
    };
    const shotsSnapshot: ScreenshotsFile = { version: 2, items: this.screenshots, groups: this.groups };
    this.saveChain = this.saveChain
      .then(async () => {
        await writeJsonAtomic(join(this.dataDir, "settings.json"), this.settings);
        await writeJsonAtomic(join(this.dataDir, "sessions.json"), sessionsSnapshot);
        await writeJsonAtomic(join(this.dataDir, "screenshots.json"), shotsSnapshot);
        await writeJsonAtomic(join(this.dataDir, "knowledge.json"), this.kb);
      })
      .catch((error: unknown) => {
        this.logger.error("persist failed", { error: String(error) });
      });
    return this.saveChain;
  }

  async commit(push = true): Promise<void> {
    await this.persist();
    if (push) this.pushState();
  }

  toast(level: "info" | "success" | "warn" | "error", message: string): void {
    this.emit("toast", { level, message });
  }

  private findSession(sessionId: string): Session | null {
    return this.sessions.find((session) => session.id === sessionId) ?? null;
  }

  private applyToSession(sessionId: string, event: SessionEvent): void {
    if (sessionId === this.currentId) {
      this.dispatch(event);
      return;
    }
    const index = this.sessions.findIndex((session) => session.id === sessionId);
    if (index >= 0) this.sessions[index] = reduceSession(this.sessions[index], event);
  }

  private cancelAllActive(): void {
    for (const [answerId, active] of this.active) {
      active.controller.abort();
      this.applyToSession(active.sessionId, {
        type: "answer.cancel",
        answerId,
        generationId: active.generationId,
        now: this.now(),
      });
    }
    this.active.clear();
  }

  async newSession(): Promise<AppSnapshot> {
    this.cancelAllActive();
    const now = this.now();
    const session = emptySession(createId("sess", { now }), now);
    this.sessions.push(session);
    if (this.sessions.length > MAX_SESSIONS) {
      const removable = this.sessions.filter((entry) => entry.id !== session.id && !entry.archived).slice(0, this.sessions.length - MAX_SESSIONS);
      const drop = new Set(removable.map((entry) => entry.id));
      this.sessions = this.sessions.filter((entry) => !drop.has(entry.id));
    }
    this.currentId = session.id;
    await this.commit();
    return this.snapshot();
  }

  async loadSession(id: string): Promise<AppSnapshot> {
    if (!this.sessions.some((session) => session.id === id)) {
      throw new AppError("NOT_FOUND", "会话不存在");
    }
    if (id === this.currentId) return this.snapshot();
    this.cancelAllActive();
    this.currentId = id;
    await this.commit();
    return this.snapshot();
  }

  async renameSession(title: string, id?: string): Promise<AppSnapshot> {
    const targetId = id && id.length > 0 ? id : this.currentId;
    const session = this.findSession(targetId);
    if (!session) throw new AppError("NOT_FOUND", "会话不存在");
    if (targetId === this.currentId) {
      this.dispatch({ type: "session.rename", title, now: this.now() });
    } else {
      this.applyToSession(targetId, { type: "session.rename", title, now: this.now() });
    }
    await this.commit();
    return this.snapshot();
  }

  async deleteSession(id: string): Promise<AppSnapshot> {
    if (!this.sessions.some((session) => session.id === id)) {
      throw new AppError("NOT_FOUND", "会话不存在");
    }
    if (id === this.currentId) this.cancelAllActive();
    this.sessions = this.sessions.filter((session) => session.id !== id);
    for (const [answerId, active] of this.active) {
      if (active.sessionId === id) {
        active.controller.abort();
        this.active.delete(answerId);
      }
    }
    if (!this.sessions.some((session) => session.id === this.currentId)) {
      const fallback = this.sessions.at(-1);
      if (fallback) {
        this.currentId = fallback.id;
      } else {
        const session = emptySession(createId("sess", { now: this.now() }), this.now());
        this.sessions.push(session);
        this.currentId = session.id;
      }
    }
    await this.commit();
    return this.snapshot();
  }

  async clearSegments(): Promise<AppSnapshot> {
    this.dispatch({ type: "segments.clear", now: this.now() });
    await this.commit();
    return this.snapshot();
  }

  async appendTranscript(payload: {
    speaker: Speaker;
    text: string;
    source?: TranscriptSegment["source"];
    startMs?: number;
    endMs?: number;
  }): Promise<{ segment: TranscriptSegment; decision: TriggerDecision }> {
    const text = payload.text.trim();
    if (!text) throw new AppError("VALIDATION", "转写文本不能为空");
    const now = this.now();
    const segment: TranscriptSegment = {
      id: createId("seg", { now }),
      speaker: payload.speaker,
      text,
      source: payload.source ?? "manual",
      startMs: payload.startMs ?? 0,
      endMs: payload.endMs ?? 0,
      final: true,
      createdAt: now,
    };
    const decision = evaluateSegment(this.currentSession(), segment, this.settings, now);
    this.dispatch({ type: "segment.append", segment, now });
    if (decision.action === "answer" && decision.question) {
      this.dispatch({ type: "trigger.mark", normalized: decision.normalized ?? normalizeForCompare(segment.text), now });
      await this.startAnswer(decision.question, "auto");
    } else if (decision.action === "queue" && decision.question) {
      const queued: QueuedQuestion = {
        id: createId("q", { now }),
        speaker: segment.speaker,
        text: decision.question,
        createdAt: now,
        reason: decision.reason,
        lane: "voice",
      };
      this.dispatch({ type: "queue.push", question: queued, now });
      this.dispatch({ type: "trigger.mark", normalized: decision.normalized ?? normalizeForCompare(segment.text), now });
    }
    await this.commit();
    return { segment, decision };
  }

  async setSegmentSpeaker(id: string, speaker: Speaker): Promise<AppSnapshot> {
    const segment = this.currentSession().segments.find((entry) => entry.id === id);
    if (!segment) throw new AppError("NOT_FOUND", "转写片段不存在");
    this.dispatch({ type: "segment.speaker", id, speaker, now: this.now() });
    await this.commit();
    return this.snapshot();
  }

  async manualTrigger(text: string, ask: boolean): Promise<{ decision: TriggerDecision; answerId?: string }> {
    const decision = shouldTriggerManually(text, this.settings.trigger.minChars);
    if (decision.action === "ignore" || !decision.question) return { decision };
    if (!ask) {
      const now = this.now();
      const segment: TranscriptSegment = {
        id: createId("seg", { now }),
        speaker: "me",
        text: decision.question,
        source: "manual",
        startMs: 0,
        endMs: 0,
        final: true,
        createdAt: now,
      };
      this.dispatch({ type: "segment.append", segment, now });
      await this.commit();
      return { decision };
    }
    const { answerId } = await this.startAnswer(decision.question, "manual");
    return { decision, answerId };
  }

  private trimAnswers(): void {
    const max = Math.max(1, this.settings.trigger.maxAnswers);
    const session = this.currentSession();
    if (session.answers.length <= max) return;
    const protectedIds = new Set<string>();
    for (const group of this.groups) {
      if (group.answerId) protectedIds.add(group.answerId);
      for (const id of group.answerIds) protectedIds.add(id);
    }
    const removable = session.answers.filter((answer) => answer.status !== "streaming" && !protectedIds.has(answer.id));
    const overflow = session.answers.length - max;
    if (overflow <= 0 || removable.length === 0) return;
    const dropIds = new Set(removable.slice(0, overflow).map((answer) => answer.id));
    this.replaceSession({
      ...session,
      answers: session.answers.filter((answer) => !dropIds.has(answer.id)),
      updatedAt: this.now(),
    });
  }

  async startAnswer(
    question: string,
    trigger: Answer["trigger"] = "manual",
    options: AnswerOptions = {},
  ): Promise<{ answerId: string; queued?: boolean }> {
    const text = question.trim();
    if (!text) throw new AppError("VALIDATION", "问题不能为空");
    const session = this.currentSession();
    const lane: AnswerLane = options.lane ?? (trigger === "screenshot" ? "screenshot" : "voice");
    const inflightId = lane === "screenshot" ? session.inflightScreenshotAnswerId : session.inflightAnswerId;
    if (inflightId) {
      if (lane === "screenshot") {
        throw new AppError("CONFLICT", "当前截图解答仍在生成中，请先等待完成或取消");
      }
      const now = this.now();
      const queued: QueuedQuestion = {
        id: createId("q", { now }),
        speaker: "interviewer",
        text,
        createdAt: now,
        reason: "busy",
        lane,
      };
      this.dispatch({ type: "queue.push", question: queued, now });
      await this.commit();
      return { answerId: inflightId, queued: true };
    }
    const now = this.now();
    const generationId = (this.generationCounter += 1);
    const answer: Answer = {
      id: createId("ans", { now }),
      generationId,
      question: text,
      trigger,
      lane,
      status: "streaming",
      text: "",
      createdAt: now,
      updatedAt: now,
      ...(options.screenshotId ? { screenshotId: options.screenshotId } : {}),
      ...(options.groupId ? { groupId: options.groupId } : {}),
      ...(options.screenshotIds && options.screenshotIds.length > 0
        ? { screenshotIds: [...options.screenshotIds] }
        : {}),
    };
    this.dispatch({ type: "answer.start", answer, now });
    this.trimAnswers();
    const controller = new AbortController();
    this.active.set(answer.id, { controller, generationId, sessionId: session.id });
    void this.executeAnswer(answer.id, text, generationId, session.id, options, lane).catch((error: unknown) => {
      this.logger.error("answer task crashed", { answerId: answer.id, error: String(error) });
    });
    await this.commit();
    return { answerId: answer.id };
  }

  private isCurrentGeneration(answerId: string, generationId: number): boolean {
    const active = this.active.get(answerId);
    return Boolean(active && active.generationId === generationId && !active.controller.signal.aborted);
  }

  private screenshotCapabilities(): { vision: boolean; extraction: boolean } {
    const vision = this.visionTarget();
    const extraction = this.extractionTarget();
    return {
      vision: vision.settings.provider === "mock" || Boolean(vision.key),
      extraction: extraction.settings.provider === "mock" || Boolean(extraction.key),
    };
  }

  private visionTarget() {
    if (this.settings.vision.useLlm) {
      return {
        settings: { ...this.settings.llm, maxTokens: this.settings.vision.maxTokens },
        key: this.secrets.get("llm"),
      };
    }
    return { settings: this.settings.vision, key: this.secrets.get("vision") };
  }

  private extractionTarget() {
    if (this.settings.extraction.useLlm) {
      return {
        settings: { ...this.settings.llm, maxTokens: this.settings.extraction.maxTokens },
        key: this.secrets.get("llm"),
      };
    }
    return { settings: this.settings.extraction, key: this.secrets.get("extraction") };
  }

  private resolveScreenshotRoute(preference?: ScreenshotStrategy): ScreenshotRoute {
    const requested = preference ?? this.settings.screenshot.strategy;
    const capabilities = this.screenshotCapabilities();
    const route = chooseScreenshotStrategy(requested, capabilities);
    if (route) return route;
    if (requested === "extract") {
      throw new AppError("VALIDATION", "提取模型未配置：请先填写提取模型的接口与 API Key，或把截图策略改为自动");
    }
    if (requested === "vision") {
      throw new AppError("VALIDATION", "视觉模型未配置：请先填写视觉模型的接口与 API Key，或把截图策略改为提取");
    }
    throw new AppError("VALIDATION", "没有可用的截图模型：请配置视觉模型或提取模型");
  }

  private setScreenshotStage(
    id: string,
    stage: ScreenshotStage,
    options: { route?: ScreenshotRoute; message?: string; answerId?: string } = {},
  ): void {
    const meta = this.screenshots.find((item) => item.id === id);
    if (!meta) return;
    const now = this.now();
    const status: ScreenshotMeta["analysis"]["status"] =
      stage === "done" ? "done" : stage === "error" ? "error" : stage === "idle" || stage === "cancelled" ? "idle" : "streaming";
    const analysis: ScreenshotMeta["analysis"] = {
      ...meta.analysis,
      status,
      stage,
      updatedAt: now,
      ...(options.route ? { route: options.route } : {}),
      ...(options.answerId ? { answerId: options.answerId } : {}),
    };
    if ((stage === "extracting" || stage === "solving" || stage === "queued") && !analysis.startedAt) {
      analysis.startedAt = now;
    }
    if (stage === "error") analysis.error = options.message ?? "分析失败";
    else delete analysis.error;
    meta.analysis = analysis;
    this.emit("screenshot.stage", {
      id,
      stage,
      ...(options.route ? { route: options.route } : {}),
      ...(options.message ? { message: options.message } : {}),
    });
    this.pushState();
  }

  private updateScreenshotAnalysis(id: string, patch: Partial<ScreenshotMeta["analysis"]>): void {
    const meta = this.screenshots.find((item) => item.id === id);
    if (!meta) return;
    meta.analysis = { ...meta.analysis, ...patch, updatedAt: this.now() };
    this.pushState();
  }

  private async readScreenshotImage(id: string): Promise<string> {
    const meta = this.findScreenshot(id);
    const shots = await import("./screenshots.ts");
    return shots.readScreenshotForModel(this.dataDir, meta);
  }

  private async extractImages(images: string[], signal: AbortSignal): Promise<ExtractedProblem> {
    const target = this.extractionTarget();
    const raw = await extractProblemFromImages(
      target.settings,
      target.key,
      images,
      buildExtractionPrompt(),
      signal,
    );
    const parsed = parseExtractedProblem(raw);
    if (!parsed) throw new AppError("PROVIDER_ERROR", "提取模型没有返回可用的题面，请检查模型是否支持图片输入");
    return parsed;
  }

  private resetAnswerText(answerId: string, generationId: number, sessionId: string): void {
    this.applyToSession(sessionId, { type: "answer.reset", answerId, generationId, now: this.now() });
    this.emit("answer.reset", { answerId, generationId });
  }

  private async executeScreenshotPlan(
    answerId: string,
    sessionId: string,
    generationId: number,
    question: string,
    plan: ScreenshotPlan,
    chunks: Array<{ docName: string; text: string }>,
    signal: AbortSignal,
    onDelta: (delta: string) => void,
    screenshotId: string | undefined,
  ): Promise<string> {
    const continuationFor = (extraction?: ExtractedProblem) =>
      plan.continuation
        ? buildContinuationContext({
            ...(plan.previousProblem ? { previousProblem: plan.previousProblem } : {}),
            previousAnswer: plan.previousAnswer ?? "",
            ...(extraction ? { newExtraction: extraction } : {}),
          })
        : undefined;
    let extraction = plan.extraction;

    const runTextSolution = async (): Promise<string> => {
      if (!extraction) {
        if (screenshotId) this.setScreenshotStage(screenshotId, "extracting", { route: "extract" });
        extraction = await this.extractImages(plan.images, signal);
        if (screenshotId) {
          this.updateScreenshotAnalysis(screenshotId, {
            route: "extract",
            extracted: extraction,
            extractionModel: this.settings.extraction.model,
          });
          this.setScreenshotStage(screenshotId, "solving", { route: "extract" });
        }
      }
      const continuationContext = continuationFor(extraction);
      const messages = buildSolutionMessages({
        problem: plan.previousProblem || extraction.problemStatement || question,
        ...(extraction.additionalContext ? { additionalContext: extraction.additionalContext } : {}),
        ...(plan.note ? { note: plan.note } : {}),
        kbChunks: chunks,
        ...(continuationContext ? { continuationContext } : {}),
      }).map(asChatMessage);
      await streamChat(
        this.settings.llm,
        this.secrets.get("llm"),
        messages,
        {
          temperature: this.settings.llm.temperature,
          maxTokens: this.settings.llm.maxTokens,
          signal,
        },
        onDelta,
      );
      if (screenshotId) this.updateScreenshotAnalysis(screenshotId, { solutionModel: this.settings.llm.model });
      return this.settings.llm.model;
    };

    if (plan.route === "extract") return runTextSolution();

    const runVisionSolution = async (): Promise<string> => {
      const target = this.visionTarget();
      const continuationContext = continuationFor(extraction);
      const prompt = buildVisionSolutionPrompt({
        problem: plan.previousProblem || question,
        ...(extraction?.additionalContext ? { additionalContext: extraction.additionalContext } : {}),
        ...(plan.note ? { note: plan.note } : {}),
        kbChunks: chunks,
        ...(continuationContext ? { continuationContext } : {}),
      });
      await analyzeImagesStream(
        target.settings,
        target.key,
        plan.images,
        prompt,
        { maxTokens: target.settings.maxTokens, signal },
        onDelta,
      );
      if (screenshotId) this.updateScreenshotAnalysis(screenshotId, { solutionModel: target.settings.model });
      return target.settings.model;
    };

    try {
      return await runVisionSolution();
    } catch (error) {
      const aborted = (error as Error)?.name === "AbortError" || signal.aborted;
      const canFallback = shouldFallbackToExtract(
        "vision",
        this.settings.screenshot.fallbackToExtract,
        this.screenshotCapabilities(),
      );
      if (aborted || !canFallback) throw error;
      this.logger.warn("vision screenshot failed, falling back to extraction", {
        answerId,
        error: String(error),
      });
      this.resetAnswerText(answerId, generationId, sessionId);
      if (screenshotId) {
        this.setScreenshotStage(screenshotId, "extracting", {
          route: "extract",
          message: "视觉解题失败，已回退到提取题面",
        });
      }
      return runTextSolution();
    }
  }

  private async executeAnswer(
    answerId: string,
    question: string,
    generationId: number,
    sessionId: string,
    options: AnswerOptions,
    lane: AnswerLane,
  ): Promise<void> {
    const active = this.active.get(answerId);
    if (!active) return;
    const { signal } = active.controller;
    const session = this.findSession(sessionId);
    const citedDocs = new Set<string>();
    try {
      const transcript = session ? buildTranscriptWindow(session.segments) : [];
      let chunks: Array<{ docName: string; text: string }> = [];
      if (this.settings.kb.enabled && this.kb.chunks.length > 0) {
        const hits = searchKb(this.kb, question, this.settings.kb.topK);
        chunks = hits.map((hit) => ({ docName: hit.docName, text: hit.text }));
        for (const chunk of chunks) citedDocs.add(chunk.docName);
      }
      const onDelta = (delta: string) => {
        if (!delta || !this.isCurrentGeneration(answerId, generationId)) return;
        const now = this.now();
        this.applyToSession(sessionId, { type: "answer.delta", answerId, generationId, delta, now });
        this.emit("answer.delta", { answerId, generationId, delta });
      };
      let model = this.settings.llm.model;
      if (options.plan) {
        model = await this.executeScreenshotPlan(
          answerId,
          sessionId,
          generationId,
          question,
          options.plan,
          chunks,
          signal,
          onDelta,
          options.screenshotId,
        );
      } else {
        const messages = buildAnswerMessages(question, {
          style: this.settings.llm.systemStyle,
          transcript,
          kbChunks: chunks,
        }).map(asChatMessage);
        await streamChat(
          this.settings.llm,
          this.secrets.get("llm"),
          messages,
          {
            temperature: this.settings.llm.temperature,
            maxTokens: this.settings.llm.maxTokens,
            signal,
          },
          onDelta,
        );
      }
      if (!this.isCurrentGeneration(answerId, generationId)) return;
      const now = this.now();
      this.applyToSession(sessionId, {
        type: "answer.done",
        answerId,
        generationId,
        now,
        model,
        citedDocs: [...citedDocs],
      });
      if (sessionId === this.currentId) this.trimAnswers();
      if (options.groupId) this.finishGroupAnalysis(options.groupId, answerId, true);
      if (options.screenshotId) this.finishScreenshotAnalysis(options.screenshotId, answerId, true);
      this.emit("answer.done", { answerId, generationId });
      this.active.delete(answerId);
      await this.commit();
      await this.drainQueue(lane);
    } catch (error) {
      const aborted = (error as Error)?.name === "AbortError" || signal.aborted;
      this.active.delete(answerId);
      if (aborted) {
        const now = this.now();
        this.applyToSession(sessionId, { type: "answer.cancel", answerId, generationId, now });
        if (options.groupId) this.finishGroupAnalysis(options.groupId, answerId, false, "已取消");
        if (options.screenshotId) this.finishScreenshotAnalysis(options.screenshotId, answerId, false, "已取消");
        this.emit("answer.error", { answerId, message: "已取消", cancelled: true });
        await this.commit();
        return;
      }
      const message = error instanceof AppError ? error.message : `生成失败：${(error as Error)?.message ?? error}`;
      const now = this.now();
      this.applyToSession(sessionId, { type: "answer.fail", answerId, generationId, now, message });
      if (options.groupId) this.finishGroupAnalysis(options.groupId, answerId, false, message);
      if (options.screenshotId) this.finishScreenshotAnalysis(options.screenshotId, answerId, false, message);
      this.emit("answer.error", { answerId, message, cancelled: false });
      this.logger.warn("answer failed", { answerId, message });
      await this.commit();
      await this.drainQueue(lane);
    }
  }

  async cancelAnswer(answerId: string): Promise<{ cancelled: boolean }> {
    const active = this.active.get(answerId);
    const answer = this.findAnswer(answerId);
    if (!active) {
      if (!answer) return { cancelled: false };
      const now = this.now();
      const owner = this.sessions.find((session) => session.answers.some((entry) => entry.id === answer.id));
      if (answer.status === "streaming" && owner) {
        this.applyToSession(owner.id, {
          type: "answer.cancel",
          answerId,
          generationId: answer.generationId,
          now,
        });
      }
      const groupId = answer.groupId ?? this.groups.find((group) => group.answerId === answerId)?.id;
      if (groupId) this.finishGroupAnalysis(groupId, answerId, false, "已取消");
      if (answer.screenshotId) this.finishScreenshotAnalysis(answer.screenshotId, answerId, false, "已取消");
      this.emit("answer.error", { answerId, message: "已取消", cancelled: true });
      await this.commit();
      return { cancelled: true };
    }
    const lane: AnswerLane = answer?.lane ?? (answer?.trigger === "screenshot" ? "screenshot" : "voice");
    active.controller.abort();
    this.active.delete(answerId);
    this.applyToSession(active.sessionId, {
      type: "answer.cancel",
      answerId,
      generationId: active.generationId,
      now: this.now(),
    });
    if (answer?.groupId) this.finishGroupAnalysis(answer.groupId, answerId, false, "已取消");
    if (answer?.screenshotId) this.finishScreenshotAnalysis(answer.screenshotId, answerId, false, "已取消");
    this.emit("answer.error", { answerId, message: "已取消", cancelled: true });
    await this.commit();
    await this.drainQueue(lane);
    return { cancelled: true };
  }

  async retryAnswer(answerId: string): Promise<{ answerId: string }> {
    const answer = this.sessions.flatMap((session) => session.answers).find((entry) => entry.id === answerId);
    if (!answer) throw new AppError("NOT_FOUND", "回答不存在");
    if (answer.status === "streaming") throw new AppError("CONFLICT", "回答仍在生成中");
    if (answer.groupId) {
      return this.solveGroup(answer.groupId);
    }
    if (answer.screenshotId) {
      const meta = this.screenshots.find((item) => item.id === answer.screenshotId);
      if (!meta) throw new AppError("NOT_FOUND", "截图已被删除，无法重试");
      const result = await this.analyzeScreenshot(meta.id, answer.question);
      return { answerId: result.answerId };
    }
    const result = await this.startAnswer(answer.question, "manual");
    return { answerId: result.answerId };
  }

  private async drainQueue(lane: AnswerLane = "voice"): Promise<void> {
    if (!this.settings.trigger.autoDrainQueue) return;
    const session = this.currentSession();
    const inflight = lane === "screenshot" ? session.inflightScreenshotAnswerId : session.inflightAnswerId;
    if (inflight) return;
    const next = session.queue.find((entry) => (entry.lane ?? "voice") === lane);
    if (!next) return;
    this.dispatch({ type: "queue.remove", id: next.id, now: this.now() });
    await this.commit(false);
    await this.startAnswer(next.text, "queue", { lane });
  }

  async queueNext(): Promise<{ answerId: string | null }> {
    const session = this.currentSession();
    if (session.inflightAnswerId) throw new AppError("CONFLICT", "当前已有回答进行中");
    const next = session.queue.find((entry) => (entry.lane ?? "voice") === "voice");
    if (!next) return { answerId: null };
    this.dispatch({ type: "queue.remove", id: next.id, now: this.now() });
    const result = await this.startAnswer(next.text, "queue", { lane: "voice" });
    return { answerId: result.answerId };
  }

  async queueRemove(id: string): Promise<AppSnapshot> {
    this.dispatch({ type: "queue.remove", id, now: this.now() });
    await this.commit();
    return this.snapshot();
  }

  async queueClear(): Promise<AppSnapshot> {
    this.dispatch({ type: "queue.clear", now: this.now() });
    await this.commit();
    return this.snapshot();
  }

  async updateSettings(next: AppSettings): Promise<AppSnapshot> {
    const cleaned = stripLegacySettings(next) as AppSettings;
    const merged = deepMerge(defaultSettings(), cleaned);
    const validated = forceRequiredDefaults(
      S.validate(settingsSchema, migrateSettings(merged, cleaned.version ?? 1)),
    );
    validated.hotkeys = normalizeHotkeySettings(validated.hotkeys);
    const previous = this.settings;
    const transcriptionChanged =
      previous.transcription.provider !== validated.transcription.provider ||
      previous.transcription.baseUrl !== validated.transcription.baseUrl ||
      previous.transcription.model !== validated.transcription.model ||
      previous.transcription.language !== validated.transcription.language ||
      previous.transcription.mode !== validated.transcription.mode;
    if (transcriptionChanged) this.disposeRealtimeSessions();
    this.settings = validated;
    if (!validated.privacy.lockEnabled) this.unlocked = true;
    this.overlay?.apply(validated);
    this.hotkeys?.apply(validated);
    await this.commit();
    return this.snapshot();
  }

  async resetSettings(): Promise<AppSnapshot> {
    this.disposeRealtimeSessions();
    this.settings = defaultSettings();
    this.unlocked = true;
    this.overlay?.apply(this.settings);
    this.hotkeys?.apply(this.settings);
    await this.commit();
    return this.snapshot();
  }

  async setSecret(key: "llm" | "transcription" | "vision" | "extraction", value: string) {
    await this.secrets.set(key, value);
    this.pushState();
    return this.secrets.status();
  }

  async clearSecret(key: "llm" | "transcription" | "vision" | "extraction") {
    await this.secrets.clear(key);
    this.pushState();
    return this.secrets.status();
  }

  async testService(service: "llm" | "transcription" | "vision" | "extraction") {
    if (service === "vision") {
      const target = this.visionTarget();
      return testProvider(service, target.settings, target.key);
    }
    if (service === "extraction") {
      const target = this.extractionTarget();
      return testProvider(service, target.settings, target.key);
    }
    const settings = service === "llm" ? this.settings.llm : this.settings.transcription;
    return testProvider(service, settings, this.secrets.get(service));
  }

  async setListening(next: ListeningState): Promise<AppSnapshot> {
    this.listening = { mic: Boolean(next.mic), system: Boolean(next.system) };
    this.pushState();
    return this.snapshot();
  }

  async transcribe(payload: {
    channel: "mic" | "system";
    mimeType: string;
    data: ArrayBuffer | Uint8Array;
    startMs?: number;
    endMs?: number;
  }): Promise<{ text: string; segment?: TranscriptSegment }> {
    if (this.settings.transcription.provider === "dashscope") {
      throw new AppError("UNSUPPORTED", "DashScope 转写使用实时流式模式，请点击开始收音后直接说话");
    }
    const audio = toAudioBuffer(payload.data);
    if (audio.byteLength === 0) throw new AppError("VALIDATION", "音频片段为空");
    this.emit("transcribe.status", { channel: payload.channel, state: "transcribing" });
    try {
      const text = await transcribeAudio(
        this.settings.transcription,
        this.secrets.get("transcription"),
        audio,
        payload.mimeType,
        AbortSignal.timeout(90000),
      );
      const cleaned = text.trim();
      if (!cleaned) {
        this.emit("transcribe.status", { channel: payload.channel, state: "done" });
        return { text: "" };
      }
      const appended = await this.enqueueTranscriptAppend(() =>
        this.appendFinalTranscript(
          payload.channel,
          payload.channel === "mic" ? this.settings.voice.micSpeaker : this.settings.voice.systemSpeaker,
          cleaned,
          payload.startMs ?? 0,
          payload.endMs ?? 0,
        ),
      );
      this.emit("transcribe.status", { channel: payload.channel, state: "done" });
      return appended.segment ? { text: cleaned, segment: appended.segment } : { text: "" };
    } catch (error) {
      const message = error instanceof AppError ? error.message : `转写失败：${(error as Error).message}`;
      this.emit("transcribe.status", { channel: payload.channel, state: "error", message });
      this.logger.warn("transcription failed", { channel: payload.channel, message });
      throw error instanceof AppError ? error : new AppError("PROVIDER_ERROR", message);
    }
  }

  async startRealtime(channel: "mic" | "system"): Promise<{ started: boolean; state: "listening" }> {
    await this.stopRealtime(channel).catch(() => undefined);
    const settings = this.settings.transcription;
    if (settings.provider !== "dashscope") {
      throw new AppError("UNSUPPORTED", "实时转写需要在设置中选择 DashScope 提供方");
    }
    if (settings.mode !== "realtime") {
      throw new AppError("UNSUPPORTED", "请把转写模式切换为“实时流式”");
    }
    const apiKey = this.secrets.get("transcription");
    if (!apiKey) throw new AppError("UNAUTHORIZED", "转写 API Key 未配置");
    if (!settings.model.trim()) throw new AppError("VALIDATION", "转写模型名不能为空");
    const epoch = ++this.realtimeEpochCounter;
    this.realtimeEpoch.set(channel, epoch);
    const speaker = channel === "mic" ? this.settings.voice.micSpeaker : this.settings.voice.systemSpeaker;
    const options: DashScopeSessionOptions = {
      url: resolveDashScopeUrl(settings.baseUrl),
      apiKey,
      model: settings.model,
      language: normalizeDashScopeLanguage(settings.language),
      onStatus: (state, message) => {
        this.emit("transcribe.status", { channel, state, message });
      },
      onPartial: (text) => {
        this.emit("transcribe.partial", { channel, text });
      },
      onFinal: (result) => {
        this.emit("transcribe.partial", { channel, text: "" });
        const task = this.enqueueTranscriptAppend(() => this.appendRealtimeFinal(channel, speaker, result, epoch));
        this.realtimeAppends.add(task);
        void task.finally(() => this.realtimeAppends.delete(task));
      },
      onError: (message) => {
        this.logger.warn("realtime transcription failed", { channel, message });
      },
    };
    const session = this.adapters.createRealtimeSession?.(options) ?? new DashScopeRealtimeSession(options);
    this.realtime.set(channel, session);
    try {
      await session.start();
    } catch (error) {
      this.realtime.delete(channel);
      this.realtimeEpoch.delete(channel);
      session.dispose();
      throw error;
    }
    return { started: true, state: "listening" };
  }

  async pushRealtime(payload: {
    channel: "mic" | "system";
    data: ArrayBuffer | Uint8Array;
  }): Promise<{ accepted: boolean; buffered: number }> {
    const session = this.realtime.get(payload.channel);
    if (!session) throw new AppError("NOT_FOUND", "实时转写尚未启动，请重新开始收音");
    const audio = toAudioBuffer(payload.data);
    if (audio.byteLength === 0) return { accepted: false, buffered: session.bufferedBytes };
    if (audio.byteLength % 2 !== 0) {
      throw new AppError("VALIDATION", "PCM16 音频数据长度必须是偶数");
    }
    session.push(new Uint8Array(audio.buffer, audio.byteOffset, audio.byteLength));
    return { accepted: true, buffered: session.bufferedBytes };
  }

  async stopRealtime(channel: "mic" | "system"): Promise<{ stopped: boolean }> {
    const session = this.realtime.get(channel);
    if (!session) {
      this.realtimeEpoch.delete(channel);
      return { stopped: false };
    }
    this.realtime.delete(channel);
    this.emit("transcribe.partial", { channel, text: "" });
    try {
      await session.stop();
    } finally {
      session.dispose();
    }
    await Promise.allSettled([...this.realtimeAppends]);
    this.realtimeEpoch.delete(channel);
    return { stopped: true };
  }

  private enqueueTranscriptAppend<T>(task: () => Promise<T>): Promise<T> {
    const run = this.transcriptAppendChain.catch(() => undefined).then(task);
    this.transcriptAppendChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /**
   * Both microphone and system loopback can hear the same remote speaker.
   * The append queue makes the cross-channel check atomic: without it two
   * simultaneous finals both pass the duplicate test and alternate the
   * speaker labels. System audio is authoritative for echoed speech.
   */
  private async appendFinalTranscript(
    channel: "mic" | "system",
    speaker: Speaker,
    text: string,
    startMs: number | undefined,
    endMs: number | undefined,
    epoch?: number,
  ): Promise<{ segment?: TranscriptSegment; dropped: boolean }> {
    if (epoch !== undefined && this.realtimeEpoch.get(channel) !== epoch) return { dropped: true };
    const now = this.now();
    const other: "mic" | "system" = channel === "mic" ? "system" : "mic";
    const echoWindowMs = 10000;
    const timed = Number.isFinite(startMs) && Number.isFinite(endMs) && Number(endMs) > Number(startMs);
    const isEcho = (segment: TranscriptSegment): boolean => {
      const segmentTimed = segment.endMs > segment.startMs;
      if (timed && segmentTimed) {
        const overlap = intervalOverlapRatio(
          Number(startMs),
          Number(endMs),
          segment.startMs,
          segment.endMs,
        );
        const similarity = textSimilarity(segment.text, text);
        if (overlap >= 0.45 && similarity >= 0.34) return true;
        if (overlap >= 0.2 && similarity >= 0.5) return true;
        return isLikelySameUtterance(segment.text, text, 0.62);
      }
      return (
        isLikelySameUtterance(segment.text, text, 0.72) ||
        textSimilarity(segment.text, text) >= 0.68
      );
    };
    const counterparts = this.currentSession().segments.filter(
      (segment) => segment.source === other && now - segment.createdAt <= echoWindowMs && isEcho(segment),
    );
    if (counterparts.length > 0) {
      if (channel === "mic") {
        this.logger.info("dropped microphone echo matching system audio", { text });
        return { dropped: true };
      }
      for (const counterpart of counterparts) {
        this.dispatch({ type: "segment.remove", id: counterpart.id, now });
      }
      await this.commit();
      this.logger.info("replaced microphone echo with system transcript", { text });
    }

    const duplicate = this.currentSession().segments.some((segment) => {
      if (segment.source !== channel || now - segment.createdAt > 2500) return false;
      if (isLikelySameUtterance(segment.text, text, 0.8)) return true;
      if (!timed || !(segment.endMs > segment.startMs)) return false;
      const overlap = intervalOverlapRatio(
        Number(startMs),
        Number(endMs),
        segment.startMs,
        segment.endMs,
      );
      return overlap >= 0.3 && textSimilarity(segment.text, text) >= 0.6;
    });
    if (duplicate) return { dropped: true };

    const appended = await this.appendTranscript({
      speaker,
      text,
      source: channel,
      startMs: startMs ?? 0,
      endMs: endMs ?? 0,
    });
    return { segment: appended.segment, dropped: false };
  }

  private async appendRealtimeFinal(
    channel: "mic" | "system",
    speaker: Speaker,
    result: RealtimeFinalResult,
    epoch: number,
  ): Promise<void> {
    const text = result.text.trim();
    if (!text) return;
    try {
      await this.appendFinalTranscript(channel, speaker, text, result.startMs, result.endMs, epoch);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn("realtime transcript append failed", { channel, message });
      this.emit("transcribe.status", { channel, state: "error", message: `写入转写失败：${message}` });
    }
  }

  private disposeRealtimeSessions(): void {
    for (const [channel, session] of this.realtime) {
      session.dispose();
      this.emit("transcribe.partial", { channel, text: "" });
      this.emit("transcribe.status", { channel, state: "idle" });
    }
    this.realtime.clear();
    this.realtimeEpoch.clear();
    this.realtimeAppends.clear();
  }

  private async pickFiles(multiple: boolean): Promise<string[]> {
    if (this.adapters.pickFiles) return this.adapters.pickFiles(multiple);
    const { dialog } = await import("electron");
    const result = await dialog.showOpenDialog({
      properties: multiple ? ["openFile", "multiSelections"] : ["openFile"],
      filters: [
        {
          name: "文本与代码",
          extensions: ["md", "txt", "markdown", "json", "csv", "log", "html", "htm", "ts", "js", "py"],
        },
      ],
    });
    return result.canceled ? [] : result.filePaths;
  }

  async pickAndImportKnowledge(): Promise<{
    imported: number;
    summary: { docCount: number; chunkCount: number; docs: KnowledgeBase["docs"] };
  }> {
    const files = await this.pickFiles(true);
    let imported = 0;
    for (const file of files) {
      try {
        const input = await readKnowledgeFile(file, this.settings.kb.maxFileBytes);
        const result = importTextIntoKb(this.kb, input, this.settings, this.now());
        this.kb = result.kb;
        imported += 1;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.warnings.push(`${file}: ${message}`);
        this.logger.warn("knowledge import skipped", { file, message });
      }
    }
    if (files.length > 0 && imported === 0) {
      throw new AppError("VALIDATION", "没有可导入的文档（仅支持文本与代码文件）");
    }
    await this.commit();
    return { imported, summary: summarizeKb(this.kb) };
  }

  async importKnowledgeText(name: string, text: string): Promise<{
    imported: number;
    docId: string;
    summary: { docCount: number; chunkCount: number; docs: KnowledgeBase["docs"] };
  }> {
    const input: ImportInput = {
      name,
      text,
      sourcePath: "",
      bytes: Buffer.byteLength(text, "utf8"),
    };
    const result = importTextIntoKb(this.kb, input, this.settings, this.now());
    this.kb = result.kb;
    await this.commit();
    return { imported: 1, docId: result.doc.id, summary: summarizeKb(this.kb) };
  }

  async deleteKnowledgeDoc(id: string): Promise<{ docCount: number; chunkCount: number; docs: KnowledgeBase["docs"] }> {
    const next = removeDocFromKb(this.kb, id);
    if (next === this.kb) throw new AppError("NOT_FOUND", "文档不存在");
    this.kb = next;
    await this.commit();
    return summarizeKb(this.kb);
  }

  async searchKnowledge(query: string, topK?: number): Promise<{ hits: Array<{ docName: string; text: string; score: number }> }> {
    const limit = Math.max(1, Math.min(topK ?? this.settings.kb.topK, 20));
    const hits = searchKb(this.kb, query, limit).map((hit) => ({
      docName: hit.docName,
      text: hit.text,
      score: hit.score,
    }));
    return { hits };
  }

  private findAnswer(id: string): Answer | null {
    for (const session of this.sessions) {
      const answer = session.answers.find((entry) => entry.id === id);
      if (answer) return answer;
    }
    return null;
  }

  private findGroup(id: string): CaptureGroup {
    const group = this.groups.find((entry) => entry.id === id);
    if (!group) throw new AppError("NOT_FOUND", "截图组不存在");
    return group;
  }

  private sessionGroups(): CaptureGroup[] {
    return this.groups.filter((group) => group.sessionId === this.currentId);
  }

  private groupShots(group: CaptureGroup): ScreenshotMeta[] {
    const order = new Map(group.screenshotIds.map((id, index) => [id, index]));
    return this.screenshots
      .filter((meta) => order.has(meta.id))
      .sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
  }

  private updateGroup(id: string, event: GroupEvent): CaptureGroup | null {
    const index = this.groups.findIndex((entry) => entry.id === id);
    if (index < 0) return null;
    const next = reduceGroup(this.groups[index], event);
    this.groups[index] = next;
    return next;
  }

  private pruneGroupsToShots(): void {
    const known = new Set(this.screenshots.map((meta) => meta.id));
    this.groups = this.groups
      .map((group) => ({ ...group, screenshotIds: group.screenshotIds.filter((id) => known.has(id)) }))
      .filter((group) => group.screenshotIds.length > 0);
  }

  private migrateGroups(): CaptureGroup[] {
    const contexts = new Map<string, ScreenshotMeta[]>();
    for (const shot of this.screenshots) {
      const key = shot.screenshotContextId || shot.id;
      const list = contexts.get(key) ?? [];
      list.push(shot);
      contexts.set(key, list);
    }
    const groups: CaptureGroup[] = [];
    for (const [contextId, shots] of contexts) {
      const shotIds = new Set(shots.map((shot) => shot.id));
      const groupId = `grp_${contextId}`;
      const matches: Array<{ sessionId: string; answer: Answer }> = [];
      for (const session of this.sessions) {
        for (const answer of session.answers) {
          if ((answer.screenshotId && shotIds.has(answer.screenshotId)) || answer.groupId === groupId) {
            matches.push({ sessionId: session.id, answer });
          }
        }
      }
      matches.sort((a, b) => a.answer.createdAt - b.answer.createdAt);
      const last = matches.at(-1);
      const status: CaptureGroup["status"] = !last
        ? "closed"
        : last.answer.status === "done"
          ? "answered"
          : last.answer.status === "cancelled"
            ? "collecting"
            : "error";
      const createdAt = Math.min(...shots.map((shot) => shot.createdAt));
      const updatedAt = Math.max(createdAt, ...shots.map((shot) => shot.createdAt), last?.answer.updatedAt ?? 0);
      groups.push({
        id: groupId,
        seq: 0,
        sessionId: last?.sessionId ?? this.currentId,
        createdAt,
        updatedAt,
        status,
        screenshotIds: shots.map((shot) => shot.id),
        answerId: last?.answer.id ?? null,
        answerIds: matches.map((match) => match.answer.id),
        ...(status === "answered" ? { solvedShotCount: shots.length } : {}),
        ...(status === "error" ? { lastError: last?.answer.error ?? "上次解题失败" } : {}),
      });
      for (const match of matches) {
        if (!match.answer.groupId) match.answer.groupId = groupId;
      }
    }
    groups.sort((a, b) => a.createdAt - b.createdAt);
    groups.forEach((group, index) => {
      group.seq = index + 1;
    });
    return groups;
  }

  trackScreenshot(meta: ScreenshotMeta): CaptureGroup {
    const now = meta.createdAt;
    let target: CaptureGroup | null = null;
    if (this.preferredGroup && now - this.preferredGroup.at <= GROUP_IDLE_MS) {
      const preferred = this.groups.find((group) => group.id === this.preferredGroup?.id);
      if (preferred && preferred.sessionId === this.currentId && canAppendToGroup(preferred)) {
        target = preferred;
      }
    }
    if (!target) {
      this.preferredGroup = null;
      target = pickCaptureGroup(this.sessionGroups(), now);
    }
    let group: CaptureGroup;
    if (target) {
      group = this.updateGroup(target.id, { type: "group.append", shotId: meta.id, now }) ?? target;
    } else {
      group = createCaptureGroup({
        id: createId("grp", { now }),
        seq: nextGroupSeq(this.groups),
        sessionId: this.currentId,
        screenshotId: meta.id,
        now,
      });
      this.groups.push(group);
    }
    this.preferredGroup = { id: group.id, at: now };
    meta.screenshotContextId = group.id;
    if (!this.screenshots.some((item) => item.id === meta.id)) this.screenshots.push(meta);
    return group;
  }

  private ensureGroupForScreenshot(meta: ScreenshotMeta): CaptureGroup {
    const existing = this.groups.find((group) => group.screenshotIds.includes(meta.id));
    if (existing) return existing;
    const now = this.now();
    const group = createCaptureGroup({
      id: createId("grp", { now }),
      seq: nextGroupSeq(this.groups),
      sessionId: this.currentId,
      screenshotId: meta.id,
      now: meta.createdAt || now,
    });
    this.groups.push(group);
    return group;
  }

  private removeGroupLocal(id: string): void {
    const index = this.groups.findIndex((group) => group.id === id);
    if (index < 0) return;
    const [group] = this.groups.splice(index, 1);
    const shotIds = new Set(group.screenshotIds);
    const answerIds = new Set<string>(group.answerIds);
    if (group.answerId) answerIds.add(group.answerId);
    for (const session of this.sessions) {
      const answers = session.answers.filter((answer) => {
        if (answerIds.has(answer.id) || answer.groupId === id) return false;
        if (answer.screenshotId && shotIds.has(answer.screenshotId)) return false;
        if (answer.screenshotIds?.some((shotId) => shotIds.has(shotId))) return false;
        return true;
      });
      if (answers.length === session.answers.length) continue;
      const inflight = session.inflightAnswerId && !answers.some((answer) => answer.id === session.inflightAnswerId);
      const screenshotInflight =
        session.inflightScreenshotAnswerId &&
        !answers.some((answer) => answer.id === session.inflightScreenshotAnswerId);
      this.replaceSession({
        ...session,
        answers,
        inflightAnswerId: inflight ? null : session.inflightAnswerId,
        inflightQuestion: inflight ? null : session.inflightQuestion,
        inflightScreenshotAnswerId: screenshotInflight ? null : session.inflightScreenshotAnswerId,
        inflightScreenshotQuestion: screenshotInflight ? null : session.inflightScreenshotQuestion,
        updatedAt: this.now(),
      });
    }
    const dropped = this.screenshots.filter((meta) => shotIds.has(meta.id));
    this.screenshots = this.screenshots.filter((meta) => !shotIds.has(meta.id));
    if (this.preferredGroup?.id === id) this.preferredGroup = null;
    void import("./screenshots.ts")
      .then((shots) => Promise.all(dropped.map((meta) => shots.deleteScreenshotFile(this.dataDir, meta))))
      .catch(() => undefined);
  }

  private setGroupError(groupId: string, message: string): void {
    const group = this.groups.find((entry) => entry.id === groupId);
    if (!group) return;
    const now = this.now();
    this.updateGroup(groupId, { type: "group.error", message, now });
    for (const meta of this.groupShots(group)) {
      meta.analysis = { ...meta.analysis, status: "error", stage: "error", error: message, updatedAt: now };
    }
    this.pushState();
  }

  private finishGroupAnalysis(groupId: string, answerId: string, ok: boolean, error?: string): void {
    const group = this.groups.find((entry) => entry.id === groupId);
    if (!group) return;
    if (group.status === "answering" && group.answerId && group.answerId !== answerId) return;
    const answer = this.findAnswer(answerId);
    const now = this.now();
    const shots = this.groupShots(group);
    if (ok && answer) {
      this.updateGroup(groupId, { type: "group.answered", answerId, now });
      for (const meta of shots) {
        meta.analysis = {
          ...meta.analysis,
          status: "done",
          stage: "done",
          answerId,
          text: answer.text,
          updatedAt: now,
        };
        delete meta.analysis.error;
      }
      const last = shots.at(-1);
      if (last) {
        this.emit("screenshot.stage", {
          id: last.id,
          stage: "done",
          ...(last.analysis.route ? { route: last.analysis.route } : {}),
        });
      }
    } else if (error === "已取消") {
      this.updateGroup(groupId, { type: "group.cancel", now });
      for (const meta of shots) {
        meta.analysis = { ...meta.analysis, status: "idle", stage: "cancelled", updatedAt: now };
        delete meta.analysis.error;
      }
      const last = shots.at(-1);
      if (last) this.emit("screenshot.stage", { id: last.id, stage: "cancelled" });
    } else {
      const message = error ?? "解题失败";
      this.updateGroup(groupId, { type: "group.error", answerId, message, now });
      for (const meta of shots) {
        meta.analysis = { ...meta.analysis, status: "error", stage: "error", error: message, updatedAt: now };
      }
      const last = shots.at(-1);
      if (last) {
        this.emit("screenshot.stage", {
          id: last.id,
          stage: "error",
          message,
          ...(last.analysis.route ? { route: last.analysis.route } : {}),
        });
      }
    }
    this.pushState();
  }

  private findScreenshot(id: string): ScreenshotMeta {
    const meta = this.screenshots.find((item) => item.id === id);
    if (!meta) throw new AppError("NOT_FOUND", "截图不存在");
    return meta;
  }

  private archiveInBackground(id: string): void {
    const meta = this.screenshots.find((item) => item.id === id);
    if (!meta) return;
    void this.archiveWithRetry(id, {
      requestId: meta.requestId,
      screenshotContextId: meta.screenshotContextId,
      archiveRequestId: meta.archiveRequestId,
    }).catch((error: unknown) => {
      this.logger.warn("screenshot archive failed", { id, error: String(error) });
    });
  }

  async captureFull(): Promise<{ meta: ScreenshotMeta; dataUrl: string }> {
    if (this.isLocked()) throw new AppError("LOCKED", "应用已锁定");
    const shots = await import("./screenshots.ts");
    const capture = await shots.captureDisplay();
    const now = this.now();
    const saved = await shots.saveScreenshot(this.dataDir, capture.image, "full", capture.display, now);
    this.trackScreenshot(saved.meta);
    this.trimScreenshots();
    this.emit("screenshot", saved);
    await this.commit();
    this.archiveInBackground(saved.meta.id);
    return saved;
  }

  async openRegionSelector(): Promise<{ opened: boolean }> {
    if (this.isLocked()) throw new AppError("LOCKED", "应用已锁定");
    if (!this.overlay) throw new AppError("UNSUPPORTED", "浮层尚未就绪");
    const opened = await this.overlay.openRegionSelector();
    return { opened };
  }

  async submitRegion(payload: {
    displayId: string;
    rect: { x: number; y: number; width: number; height: number };
    scaleFactor: number;
  }): Promise<{ meta: ScreenshotMeta; dataUrl: string }> {
    if (this.isLocked()) throw new AppError("LOCKED", "应用已锁定");
    const shots = await import("./screenshots.ts");
    const pending = shots.getPendingRegionCapture(payload.displayId);
    if (!pending) throw new AppError("CONFLICT", "截图选区已失效，请重新截图");
    const cropped = shots.cropImage(pending.image, pending.display, payload.rect);
    const now = this.now();
    const saved = await shots.saveScreenshot(this.dataDir, cropped, "region", pending.display, now);
    this.trackScreenshot(saved.meta);
    this.trimScreenshots();
    this.emit("screenshot", saved);
    shots.clearPendingRegionCapture();
    this.overlay?.closeRegionSelector();
    await this.commit();
    this.archiveInBackground(saved.meta.id);
    return saved;
  }

  async cancelRegion(): Promise<{ closed: boolean }> {
    const closed = this.overlay?.closeRegionSelector() ?? false;
    if (closed) this.preferredGroup = null;
    return { closed };
  }

  private trimScreenshots(): void {
    while (this.screenshots.length > MAX_SCREENSHOTS) {
      const grouped = new Set(this.groups.flatMap((group) => group.screenshotIds));
      const removable = this.groups
        .filter((group) => group.status !== "answering")
        .sort((a, b) => a.createdAt - b.createdAt)[0];
      if (removable) {
        this.removeGroupLocal(removable.id);
        continue;
      }
      const orphan = this.screenshots.find((meta) => !grouped.has(meta.id));
      if (!orphan) break;
      this.screenshots = this.screenshots.filter((meta) => meta.id !== orphan.id);
      void import("./screenshots.ts")
        .then((shots) => shots.deleteScreenshotFile(this.dataDir, orphan))
        .catch(() => undefined);
    }
  }

  private finishScreenshotAnalysis(id: string, answerId: string, ok: boolean, error?: string): void {
    const meta = this.screenshots.find((item) => item.id === id);
    if (!meta) return;
    const now = this.now();
    const answer = this.sessions
      .flatMap((session) => session.answers)
      .find((entry) => entry.id === answerId);
    if (ok && answer) {
      meta.analysis = {
        ...meta.analysis,
        status: "done",
        stage: "done",
        answerId: answer.id,
        text: answer.text,
        updatedAt: now,
      };
      delete meta.analysis.error;
      this.emit("screenshot.stage", {
        id,
        stage: "done",
        ...(meta.analysis.route ? { route: meta.analysis.route } : {}),
      });
    } else if (error === "已取消") {
      meta.analysis = { ...meta.analysis, status: "idle", stage: "cancelled", updatedAt: now };
      delete meta.analysis.error;
      this.emit("screenshot.stage", { id, stage: "cancelled" });
    } else {
      meta.analysis = { ...meta.analysis, status: "error", stage: "error", error: error ?? "分析失败", updatedAt: now };
      this.emit("screenshot.stage", {
        id,
        stage: "error",
        message: error ?? "分析失败",
        ...(meta.analysis.route ? { route: meta.analysis.route } : {}),
      });
    }
    this.pushState();
  }

  private screenshotImageLimit(): number {
    return Math.max(1, Math.min(6, Math.round(this.settings.screenshot.maxImages)));
  }

  private beginScreenshotTask(label: string): object {
    if (this.screenshotTask) {
      throw new AppError("CONFLICT", `正在${this.screenshotTask.label}，请等待完成后再试`);
    }
    const token = {};
    this.screenshotTask = { label, token };
    return token;
  }

  private endScreenshotTask(token: object): void {
    // Only the owner of the running task may clear it. A cancelled solve can
    // unwind after a newer task has started, and must not drop its state.
    if (this.screenshotTask?.token === token) this.screenshotTask = null;
  }

  private currentGroup(groupId: string): CaptureGroup {
    const group = this.findGroup(groupId);
    if (group.sessionId !== this.currentId) throw new AppError("NOT_FOUND", "截图组不属于当前会话");
    return group;
  }

  async solveGroup(
    groupId: string,
    note?: string,
    strategy?: ScreenshotStrategy,
  ): Promise<{ answerId: string }> {
    if (this.isLocked()) throw new AppError("LOCKED", "应用已锁定");
    const group = this.currentGroup(groupId);
    if (group.status === "answering") throw new AppError("CONFLICT", "本组正在解题，请先停止");
    if (group.status === "closed") throw new AppError("VALIDATION", "本组已结束，请先补图重新打开");
    if (this.currentSession().inflightScreenshotAnswerId) {
      throw new AppError("CONFLICT", "当前截图解答仍在生成中，请先等待完成或取消");
    }
    const shots = this.groupShots(group);
    if (shots.length === 0) throw new AppError("NOT_FOUND", "本组没有可用截图");

    const taskToken = this.beginScreenshotTask("解题");
    const abort = new AbortController();
    this.screenshotAborts.set(groupId, abort);
    const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(120000)]);
    const assertSolving = () => {
      const current = this.groups.find((entry) => entry.id === groupId);
      // The group is still "collecting"/"answered"/"error" while images are
      // read and before the answering state is entered. Only an explicit
      // abort, deletion, or closure may cancel the task at this stage.
      if (abort.signal.aborted || !current || current.status === "closed") {
        throw new AppError("CANCELLED", "已取消");
      }
    };
    try {
      const images = (await Promise.all(shots.map((meta) => this.readScreenshotImage(meta.id)))).slice(
        -this.screenshotImageLimit(),
      );
      assertSolving();
      const route = this.resolveScreenshotRoute(strategy);
      const now = this.now();
      for (const meta of shots) {
        meta.analysis = {
          ...meta.analysis,
          status: "streaming",
          stage: route === "extract" ? "extracting" : "solving",
          route,
          startedAt: now,
          updatedAt: now,
          sourceScreenshotIds: [...group.screenshotIds],
        };
        delete meta.analysis.error;
        delete meta.analysis.answerId;
      }
      group.status = "answering";
      group.answerId = null;
      group.updatedAt = now;
      delete group.lastError;
      const last = shots.at(-1) as ScreenshotMeta;
      this.emit("screenshot.stage", {
        id: last.id,
        stage: route === "extract" ? "extracting" : "solving",
        route,
      });
      this.pushState();

      let extraction: ExtractedProblem | undefined;
      if (route === "extract") {
        extraction = await this.extractImages(images, signal);
        assertSolving();
        for (const meta of shots) {
          meta.analysis = {
            ...meta.analysis,
            status: "streaming",
            stage: "solving",
            route: "extract",
            extracted: extraction,
            extractionModel: this.settings.extraction.model,
            updatedAt: this.now(),
          };
        }
        this.emit("screenshot.stage", { id: last.id, stage: "solving", route: "extract" });
        this.pushState();
      }

      const question = extraction
        ? screenshotQuestion(extraction, note)
        : note?.trim() || "请解答截图中的题目并给出完整解答";
      assertSolving();
      const started = await this.startAnswer(question, "screenshot", {
        screenshotId: last.id,
        screenshotIds: [...group.screenshotIds],
        groupId,
        ...(note ? { note } : {}),
        plan: {
          route,
          images,
          ...(note ? { note } : {}),
          ...(extraction ? { extraction } : {}),
        },
      });

      const current = this.groups.find((entry) => entry.id === groupId);
      if (current && current.status === "answering") {
        this.updateGroup(groupId, {
          type: "group.answering",
          answerId: started.answerId,
          shotCount: current.screenshotIds.length,
          now: this.now(),
        });
        for (const meta of this.groupShots(current)) {
          if (meta.analysis.status === "streaming") meta.analysis.answerId = started.answerId;
        }
      } else {
        await this.cancelAnswer(started.answerId);
        await this.persist();
        return { answerId: "" };
      }
      await this.commit();
      return { answerId: started.answerId };
    } catch (error) {
      if (abort.signal.aborted || (error instanceof AppError && error.code === "CANCELLED")) {
        const current = this.groups.find((entry) => entry.id === groupId);
        if (current && current.status === "answering") {
          const now = this.now();
          this.updateGroup(groupId, { type: "group.cancel", now });
          for (const meta of this.groupShots(current)) {
            meta.analysis = { ...meta.analysis, status: "idle", stage: "cancelled", updatedAt: now };
            delete meta.analysis.error;
          }
          this.pushState();
        }
        await this.persist();
        return { answerId: "" };
      }
      const message = error instanceof AppError ? error.message : "截图组解题失败：" + String((error as Error)?.message ?? error);
      const current = this.groups.find((entry) => entry.id === groupId);
      if (current && current.status !== "answered") this.setGroupError(groupId, message);
      await this.persist();
      throw error;
    } finally {
      if (this.screenshotAborts.get(groupId) === abort) this.screenshotAborts.delete(groupId);
      this.endScreenshotTask(taskToken);
    }
  }

  async retryGroup(groupId: string): Promise<{ answerId: string }> {
    return this.solveGroup(groupId);
  }

  async stopGroup(groupId: string): Promise<{ cancelled: boolean }> {
    if (this.isLocked()) throw new AppError("LOCKED", "应用已锁定");
    const group = this.currentGroup(groupId);
    const abort = this.screenshotAborts.get(groupId);
    const inflight = this.currentSession().inflightScreenshotAnswerId;
    // group.answerId survives completion, so never treat it as running unless
    // the group is actually answering or a solve task is abortable.
    const answerId = group.status === "answering" ? (group.answerId ?? inflight ?? "") : (abort ? (inflight ?? "") : "");
    // The solve task is registered before the group flips to "answering"
    // (image reads and route resolution), so status alone is not enough.
    if (group.status !== "answering" && !abort && !answerId) return { cancelled: false };
    abort?.abort();
    if (answerId) {
      const result = await this.cancelAnswer(answerId);
      if (result.cancelled) return result;
    }
    const now = this.now();
    const current = this.groups.find((entry) => entry.id === groupId);
    if (current && (current.status === "answering" || abort)) {
      this.updateGroup(groupId, { type: "group.cancel", now });
    }
    for (const meta of this.groupShots(group)) {
      if (meta.analysis.status === "streaming" || meta.analysis.stage === "solving" || meta.analysis.stage === "extracting") {
        meta.analysis = { ...meta.analysis, status: "idle", stage: "cancelled", updatedAt: now };
        delete meta.analysis.error;
      }
    }
    this.emit("screenshot.stage", { id: group.screenshotIds.at(-1) ?? "", stage: "cancelled" });
    this.pushState();
    await this.commit();
    return { cancelled: true };
  }

  async extractGroup(groupId: string): Promise<{ extracted: ExtractedProblem }> {
    if (this.isLocked()) throw new AppError("LOCKED", "应用已锁定");
    const group = this.currentGroup(groupId);
    if (group.status === "answering") throw new AppError("CONFLICT", "本组正在解题，请先停止");
    const shots = this.groupShots(group);
    if (shots.length === 0) throw new AppError("NOT_FOUND", "本组没有可用截图");

    const taskToken = this.beginScreenshotTask("提取题面");
    try {
      const images = (await Promise.all(shots.map((meta) => this.readScreenshotImage(meta.id)))).slice(
        -this.screenshotImageLimit(),
      );
      const now = this.now();
      for (const meta of shots) {
        meta.analysis = {
          ...meta.analysis,
          status: "streaming",
          stage: "extracting",
          route: "extract",
          startedAt: now,
          updatedAt: now,
          sourceScreenshotIds: [...group.screenshotIds],
        };
        delete meta.analysis.error;
      }
      this.pushState();
      const extracted = await this.extractImages(images, AbortSignal.timeout(120000));
      for (const meta of shots) {
        meta.analysis = {
          ...meta.analysis,
          status: "done",
          stage: "done",
          route: "extract",
          extracted,
          extractionModel: this.settings.extraction.model,
          updatedAt: this.now(),
        };
        delete meta.analysis.error;
      }
      const last = shots.at(-1) as ScreenshotMeta;
      this.emit("screenshot.stage", { id: last.id, stage: "done", route: "extract" });
      this.pushState();
      await this.persist();
      return { extracted };
    } catch (error) {
      const message = error instanceof AppError ? error.message : "题面提取失败：" + String((error as Error)?.message ?? error);
      this.setGroupError(groupId, message);
      await this.persist();
      throw error;
    } finally {
      this.endScreenshotTask(taskToken);
    }
  }

  async reopenGroup(groupId: string): Promise<{ opened: boolean }> {
    if (this.isLocked()) throw new AppError("LOCKED", "应用已锁定");
    const group = this.currentGroup(groupId);
    if (group.status === "answering") throw new AppError("CONFLICT", "本组正在解题，请先停止");
    this.updateGroup(groupId, { type: "group.reopen", now: this.now() });
    this.preferredGroup = { id: groupId, at: this.now() };
    let opened = false;
    try {
      opened = await this.openRegionSelector();
    } finally {
      if (!opened) this.preferredGroup = null;
    }
    await this.persist();
    return { opened };
  }

  async closeGroup(groupId: string): Promise<{ closed: boolean }> {
    if (this.isLocked()) throw new AppError("LOCKED", "应用已锁定");
    const group = this.currentGroup(groupId);
    if (group.status === "answering") throw new AppError("CONFLICT", "本组正在解题，请先停止");
    if (group.status === "closed") return { closed: false };
    this.updateGroup(groupId, { type: "group.close", now: this.now() });
    if (this.preferredGroup?.id === groupId) this.preferredGroup = null;
    await this.commit();
    return { closed: true };
  }

  async deleteGroup(groupId: string): Promise<{ deleted: boolean }> {
    if (this.isLocked()) throw new AppError("LOCKED", "应用已锁定");
    const group = this.currentGroup(groupId);
    if (group.status === "answering") throw new AppError("CONFLICT", "本组正在解题，请先停止再删除");
    this.removeGroupLocal(groupId);
    await this.commit();
    return { deleted: true };
  }

  async analyzeScreenshot(
    id: string,
    note?: string,
    strategy?: ScreenshotStrategy,
  ): Promise<{ answerId: string }> {
    if (this.isLocked()) throw new AppError("LOCKED", "应用已锁定");
    const meta = this.findScreenshot(id);
    const group = this.ensureGroupForScreenshot(meta);
    return this.solveGroup(group.id, note, strategy);
  }

  async extractScreenshot(id: string): Promise<{ extracted: ExtractedProblem }> {
    if (this.isLocked()) throw new AppError("LOCKED", "应用已锁定");
    const meta = this.findScreenshot(id);
    const group = this.ensureGroupForScreenshot(meta);
    return this.extractGroup(group.id);
  }

  async continueScreenshot(
    id: string,
    previousAnswerId?: string,
    note?: string,
  ): Promise<{ answerId: string }> {
    if (this.isLocked()) throw new AppError("LOCKED", "应用已锁定");
    const meta = this.findScreenshot(id);
    if (this.currentSession().inflightScreenshotAnswerId) {
      throw new AppError("CONFLICT", "当前截图解答仍在生成中，请先等待完成或取消");
    }
    const taskToken = this.beginScreenshotTask("补图续解");
    try {
      const answers = this.sessions
      .flatMap((session) => session.answers)
      .filter((answer) => answer.status === "done" && answer.screenshotId && answer.screenshotId !== id);
      const previous = previousAnswerId
      ? answers.find((answer) => answer.id === previousAnswerId)
      : answers
          .filter((answer) => {
            const source = this.screenshots.find((item) => item.id === answer.screenshotId);
            return source?.screenshotContextId === meta.screenshotContextId;
          })
          .sort((a, b) => b.createdAt - a.createdAt)[0] ?? answers.sort((a, b) => b.createdAt - a.createdAt)[0];
      if (!previous || !previous.screenshotId) {
      throw new AppError("CONFLICT", "没有可续解的上一版解答，请先完成一次截图解题");
      }
      const previousMeta = this.screenshots.find((item) => item.id === previous.screenshotId);
      if (!previousMeta) throw new AppError("NOT_FOUND", "原题截图已被删除，无法续解");
      const group = this.ensureGroupForScreenshot(previousMeta);
      const now = this.now();
      if (!group.screenshotIds.includes(id)) {
        group.screenshotIds = [...group.screenshotIds, id];
        group.updatedAt = now;
      }
      group.status = "answering";
      group.answerId = null;
      delete group.lastError;
      const route = this.resolveScreenshotRoute();
      const newImage = await this.readScreenshotImage(id);
      const previousImage = await this.readScreenshotImage(previousMeta.id);
      const images = [previousImage, newImage].slice(0, this.screenshotImageLimit());
      const previousProblem =
      previousMeta.analysis.extracted?.problemStatement || previous.question;
      meta.screenshotContextId = previousMeta.screenshotContextId;
      meta.analysis = {
      ...meta.analysis,
      status: "streaming",
      stage: route === "extract" ? "extracting" : "solving",
      route,
      startedAt: now,
      updatedAt: now,
      continuationOfAnswerId: previous.id,
      sourceScreenshotIds: [previousMeta.id, id],
      };
      this.emit("screenshot.stage", { id, stage: meta.analysis.stage as ScreenshotStage, route });
      this.pushState();
      let extraction: ExtractedProblem | undefined;
      if (route === "extract") {
        extraction = await this.extractImages([newImage], AbortSignal.timeout(120000));
        this.updateScreenshotAnalysis(id, {
          extracted: extraction,
          extractionModel: this.settings.extraction.model,
          stage: "solving",
        });
        this.emit("screenshot.stage", { id, stage: "solving", route });
        if (this.currentSession().inflightScreenshotAnswerId) {
          throw new AppError("CONFLICT", "补充题面已提取，但当前截图解答仍在生成中，请稍后重新点击续解");
        }
      }
      const question = note?.trim() ? `${previousProblem}\n\n补充要求：${note.trim()}` : previousProblem;
      const { answerId } = await this.startAnswer(question, "screenshot", {
        screenshotId: id,
        screenshotIds: [...group.screenshotIds],
        groupId: group.id,
        ...(note ? { note } : {}),
        plan: {
          route,
          images,
          previousProblem,
          previousAnswer: previous.text,
          continuation: true,
          ...(note ? { note } : {}),
          ...(extraction ? { extraction } : {}),
        },
      });
      const current = this.groups.find((entry) => entry.id === group.id);
      if (current && current.status === "answering") {
        this.updateGroup(group.id, {
          type: "group.answering",
          answerId,
          shotCount: current.screenshotIds.length,
          now: this.now(),
        });
      }
      if (meta.analysis.status === "streaming") meta.analysis.answerId = answerId;
      await this.persist();
      return { answerId };
    } catch (error) {
      const message = error instanceof AppError ? error.message : `补图续解失败：${(error as Error)?.message ?? error}`;
      this.setScreenshotStage(id, "error", { route: meta.analysis.route, message });
      await this.persist();
      throw error;
    } finally {
      this.endScreenshotTask(taskToken);
    }
  }

  async archiveWithRetry(id: string, guard: ArchiveGuard): Promise<ScreenshotMeta> {
    const meta = this.findScreenshot(id);
    const check = checkArchiveGuard(meta, guard);
    if (!check.ok) {
      throw new AppError("CONFLICT", `归档参数不匹配：${check.reason}`, check);
    }
    const shots = await import("./screenshots.ts");
    let lastError = "";
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      meta.archiveAttempts += 1;
      try {
        const path = await shots.archiveScreenshotFile(this.dataDir, meta, this.now());
        meta.archiveState = "archived";
        meta.archivedPath = path;
        delete meta.archiveError;
        await this.commit();
        return { ...meta };
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        meta.archiveError = lastError;
        meta.archiveState = attempt >= 3 ? "failed" : "pending";
        await this.persist();
        if (attempt < 3) {
          const delay = this.adapters.archiveDelayMs?.(attempt) ?? archiveRetryDelay(attempt);
          await sleep(delay);
        }
      }
    }
    meta.archiveState = "failed";
    meta.archiveError = lastError;
    await this.commit();
    this.toast("warn", "截图已保存，但归档失败；可在截图池中重试");
    return { ...meta };
  }

  async deleteScreenshot(id: string): Promise<{ deleted: boolean }> {
    const index = this.screenshots.findIndex((item) => item.id === id);
    if (index < 0) return { deleted: false };
    const group = this.groups.find((entry) => entry.screenshotIds.includes(id));
    if (group?.status === "answering") throw new AppError("CONFLICT", "本组正在解题，请先停止再删除截图");
    if (group && group.screenshotIds.length > 1) {
      group.screenshotIds = group.screenshotIds.filter((shotId) => shotId !== id);
      group.updatedAt = this.now();
    } else if (group) {
      this.removeGroupLocal(group.id);
      await this.commit();
      return { deleted: true };
    }
    const [meta] = this.screenshots.splice(index, 1);
    const shots = await import("./screenshots.ts");
    await shots.deleteScreenshotFile(this.dataDir, meta);
    await this.commit();
    return { deleted: true };
  }

  async readScreenshot(id: string): Promise<{ dataUrl: string }> {
    const meta = this.findScreenshot(id);
    const shots = await import("./screenshots.ts");
    return { dataUrl: await shots.readScreenshotAsDataUrl(this.dataDir, meta) };
  }

  listScreenshots(): ScreenshotMeta[] {
    return this.screenshots.map((item) => ({ ...item }));
  }

  async updateOverlay(patch: Partial<AppSettings["overlay"]>): Promise<AppSnapshot> {
    this.settings = forceRequiredDefaults(
      S.validate(settingsSchema, deepMerge(this.settings, { overlay: patch })),
    );
    this.overlay?.apply(this.settings);
    this.hotkeys?.apply(this.settings);
    await this.commit();
    return this.snapshot();
  }

  async nudgeOverlayOpacity(delta: number): Promise<AppSnapshot> {
    const opacity = Math.round(Math.max(0.2, Math.min(1, this.settings.overlay.opacity + delta)) * 100) / 100;
    this.settings = { ...this.settings, overlay: { ...this.settings.overlay, opacity } };
    this.overlay?.apply(this.settings);
    await this.commit();
    return this.snapshot();
  }

  async toggleOverlay(): Promise<AppSnapshot> {
    this.overlay?.toggle();
    return this.snapshot();
  }

  resizeOverlay(size: { width: number; height: number }): { width: number; height: number } {
    const width = Math.round(Math.max(680, Math.min(4000, size.width)));
    const height = Math.round(Math.max(480, Math.min(4000, size.height)));
    this.overlay?.resize({ width, height });
    return { width, height };
  }

  hoverOverlay(inside: boolean): { clickThrough: boolean } {
    void inside;
    return { clickThrough: this.settings.overlay.clickThrough };
  }

  setOverlayInteraction(active: boolean): { active: boolean } {
    this.overlay?.setInteraction(active);
    return { active };
  }

  dragOverlay(phase: "start" | "move" | "end", dx?: number, dy?: number): { moved: boolean } {
    this.overlay?.drag(phase, dx, dy);
    return { moved: phase !== "end" };
  }

  saveOverlayBounds(bounds: AppSettings["overlay"]["bounds"]): void {
    this.settings = { ...this.settings, overlay: { ...this.settings.overlay, bounds } };
    const now = this.now();
    if (now - this.lastOverlaySave < 500) return;
    this.lastOverlaySave = now;
    void this.persist();
  }

  applyHotkeys(): void {
    this.hotkeys?.apply(this.settings);
  }

  lockStatus(): { enabled: boolean; unlocked: boolean } {
    return {
      enabled: this.secrets.hasLock() && this.settings.privacy.lockEnabled,
      unlocked: this.unlocked,
    };
  }

  async lock(): Promise<{ enabled: boolean; unlocked: boolean }> {
    if (!this.secrets.hasLock()) throw new AppError("CONFLICT", "尚未设置本地密码");
    this.unlocked = false;
    this.pushState();
    return this.lockStatus();
  }

  async unlock(passcode: string): Promise<{ unlocked: boolean; remaining: number }> {
    if (!this.secrets.hasLock()) throw new AppError("CONFLICT", "尚未设置本地密码");
    const now = this.now();
    if (now < this.lockBlockedUntil) {
      throw new AppError("LIMIT", "尝试次数过多，请稍后再试");
    }
    if (!this.secrets.verifyLock(passcode)) {
      this.lockFailures += 1;
      if (this.lockFailures >= 5) {
        this.lockFailures = 0;
        this.lockBlockedUntil = now + 60000;
      }
      throw new AppError("UNAUTHORIZED", "密码错误");
    }
    this.lockFailures = 0;
    this.unlocked = true;
    this.pushState();
    return { unlocked: true, remaining: 0 };
  }

  async setLock(passcode: string): Promise<{ enabled: boolean }> {
    if (passcode.length < 4) throw new AppError("VALIDATION", "密码至少 4 位");
    await this.secrets.setLock(passcode);
    this.settings = { ...this.settings, privacy: { ...this.settings.privacy, lockEnabled: true } };
    this.unlocked = true;
    await this.commit();
    return { enabled: true };
  }

  async clearLock(passcode: string): Promise<{ enabled: boolean }> {
    if (!this.secrets.hasLock()) return { enabled: false };
    if (!this.secrets.verifyLock(passcode)) throw new AppError("UNAUTHORIZED", "密码错误");
    await this.secrets.clearLock();
    this.settings = { ...this.settings, privacy: { ...this.settings.privacy, lockEnabled: false } };
    this.unlocked = true;
    await this.commit();
    return { enabled: false };
  }

  async shutdown(): Promise<void> {
    this.disposeRealtimeSessions();
    this.cancelAllActive();
    await this.persist();
    this.logger.info("service shutdown");
  }
}
