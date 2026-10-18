import type {
  AppSnapshot,
  AppSettings,
  ArchiveState,
  KnowledgeDoc,
  ScreenshotMeta,
  SecretKey,
  SecretsStatus,
  Session,
  SessionSummary,
  Speaker,
  TranscriptSegment,
} from "./models.ts";
import { S, type Validator } from "./schema.ts";
import type { TriggerDecision } from "./trigger.ts";
import { HOTKEY_DEFINITIONS, type HotkeyActionId } from "./hotkeys.ts";

export const APP_SCHEME = "app";
export const APP_HOST = "desktophelper";

const providerKind = S.union([
  S.literal("mock"),
  S.literal("openai"),
  S.literal("dashscope"),
  S.literal("dashscope-http"),
]);
const speakerSchema = S.union([S.literal("me"), S.literal("interviewer")]);
const secretKeySchema = S.union([
  S.literal("llm"),
  S.literal("transcription"),
  S.literal("vision"),
  S.literal("extraction"),
]);
const serviceSchema = S.union([
  S.literal("llm"),
  S.literal("transcription"),
  S.literal("vision"),
  S.literal("extraction"),
]);

const boundsSchema = S.object({
  x: S.number({ integer: true }),
  y: S.number({ integer: true }),
  width: S.number({ integer: true, min: 200 }),
  height: S.number({ integer: true, min: 120 }),
});

const overlayShape = {
  opacity: S.number({ min: 0.2, max: 1 }),
  fontSize: S.number({ integer: true, min: 10, max: 28 }),
  clickThrough: S.boolean(),
  compact: S.boolean(),
  alwaysOnTop: S.boolean(),
  bounds: S.union([boundsSchema, S.literal(null)]),
};

const hotkeyShape = Object.fromEntries(
  HOTKEY_DEFINITIONS.map((definition) => [definition.id, S.string({ min: 0, max: 80 })]),
) as Record<HotkeyActionId, Validator<string>>;

export const settingsSchema = S.object({
  version: S.number({ integer: true, min: 1 }),
  transcription: S.object({
    provider: providerKind,
    baseUrl: S.string({ min: 1, max: 500 }),
    model: S.string({ min: 1, max: 200 }),
    language: S.string({ max: 32 }),
    chunkSeconds: S.number({ integer: true, min: 4, max: 60 }),
    mode: S.union([S.literal("batch"), S.literal("realtime")]),
  }),
  llm: S.object({
    provider: providerKind,
    baseUrl: S.string({ min: 1, max: 500 }),
    model: S.string({ min: 1, max: 200 }),
    temperature: S.number({ min: 0, max: 2 }),
    maxTokens: S.number({ integer: true, min: 128, max: 16000 }),
    systemStyle: S.union([S.literal("concise"), S.literal("detailed"), S.literal("star")]),
  }),
  vision: S.object({
    provider: providerKind,
    baseUrl: S.string({ min: 1, max: 500 }),
    model: S.string({ min: 1, max: 200 }),
    maxTokens: S.number({ integer: true, min: 128, max: 16000 }),
    useLlm: S.boolean(),
  }),
  extraction: S.object({
    provider: providerKind,
    baseUrl: S.string({ min: 1, max: 500 }),
    model: S.string({ min: 1, max: 200 }),
    maxTokens: S.number({ integer: true, min: 128, max: 16000 }),
    useLlm: S.boolean(),
  }),
  screenshot: S.object({
    strategy: S.union([S.literal("auto"), S.literal("vision"), S.literal("extract")]),
    fallbackToExtract: S.boolean(),
    maxImages: S.number({ integer: true, min: 1, max: 6 }),
  }),
  trigger: S.object({
    autoAnswer: S.boolean(),
    minChars: S.number({ integer: true, min: 1, max: 200 }),
    targetSpeaker: S.union([S.literal("interviewer"), S.literal("me"), S.literal("both")]),
    throttleMs: S.number({ integer: true, min: 0, max: 120000 }),
    dedupeWindowMs: S.number({ integer: true, min: 0, max: 600000 }),
    autoDrainQueue: S.boolean(),
    maxAnswers: S.number({ integer: true, min: 1, max: 50 }),
  }),
  overlay: S.object(overlayShape),
  kb: S.object({
    enabled: S.boolean(),
    topK: S.number({ integer: true, min: 1, max: 12 }),
    maxFileBytes: S.number({ integer: true, min: 1000, max: 50000000 }),
    chunkSize: S.number({ integer: true, min: 200, max: 4000 }),
    chunkOverlap: S.number({ integer: true, min: 0, max: 2000 }),
  }),
  privacy: S.object({
    storeTranscripts: S.boolean(),
    lockEnabled: S.boolean(),
    excludeFromCapture: S.boolean(),
  }),
  voice: S.object({
    captureSystemAudio: S.boolean(),
    micSpeaker: speakerSchema,
    systemSpeaker: speakerSchema,
  }),
  hotkeys: S.object(hotkeyShape),
});

export const overlayPatchSchema = S.partial(overlayShape);

const rectSchema = S.object({
  x: S.number({ min: 0 }),
  y: S.number({ min: 0 }),
  width: S.number({ min: 1 }),
  height: S.number({ min: 1 }),
});

export const payloadSchemas = {
  "app.snapshot": S.object({}),
  "app.ready": S.object({ renderer: S.string({ max: 40 }) }),
  "settings.update": settingsSchema,
  "settings.reset": S.object({}),
  "secrets.status": S.object({}),
  "secrets.set": S.object({ key: secretKeySchema, value: S.string({ max: 4096 }) }),
  "secrets.clear": S.object({ key: secretKeySchema }),
  "providers.test": S.object({ service: serviceSchema }),
  "session.new": S.object({}),
  "session.load": S.object({ id: S.string({ min: 1, max: 120 }) }),
  "session.list": S.object({}),
  "session.rename": S.object({ id: S.string({ max: 120 }).optional(), title: S.string({ min: 1, max: 80 }) }),
  "session.delete": S.object({ id: S.string({ min: 1, max: 120 }) }),
  "session.clearSegments": S.object({}),
  "transcript.append": S.object({
    speaker: speakerSchema,
    text: S.string({ min: 1, max: 8000 }),
    source: S.union([S.literal("mic"), S.literal("system"), S.literal("manual")]).optional(),
    startMs: S.number({ min: 0 }).optional(),
    endMs: S.number({ min: 0 }).optional(),
  }),
  "transcript.setSpeaker": S.object({ id: S.string({ min: 1, max: 120 }), speaker: speakerSchema }),
  "listening.update": S.object({ mic: S.boolean(), system: S.boolean() }),
  "transcribe.audio": S.object({
    channel: S.union([S.literal("mic"), S.literal("system")]),
    mimeType: S.string({ min: 1, max: 120 }),
    data: S.any(),
    startMs: S.number({ min: 0 }).optional(),
    endMs: S.number({ min: 0 }).optional(),
  }),
  "transcribe.startRealtime": S.object({
    channel: S.union([S.literal("mic"), S.literal("system")]),
  }),
  "transcribe.pushPcm": S.object({
    channel: S.union([S.literal("mic"), S.literal("system")]),
    data: S.any(),
  }),
  "transcribe.stopRealtime": S.object({
    channel: S.union([S.literal("mic"), S.literal("system")]),
  }),
  "trigger.manual": S.object({ text: S.string({ min: 1, max: 8000 }), ask: S.boolean() }),
  "answer.start": S.object({
    question: S.string({ min: 1, max: 8000 }),
    trigger: S.union([S.literal("manual"), S.literal("queue"), S.literal("knowledge")]).optional(),
  }),
  "answer.cancel": S.object({ answerId: S.string({ min: 1, max: 120 }) }),
  "answer.retry": S.object({ answerId: S.string({ min: 1, max: 120 }) }),
  "queue.next": S.object({}),
  "queue.remove": S.object({ id: S.string({ min: 1, max: 120 }) }),
  "queue.clear": S.object({}),
  "screenshot.captureFull": S.object({}),
  "screenshot.captureRegion": S.object({}),
  "screenshot.regionPreview": S.object({ displayId: S.string({ max: 40 }) }),
  "screenshot.regionReady": S.object({}),
  "screenshot.submitRegion": S.object({
    displayId: S.string({ max: 40 }),
    rect: rectSchema,
    scaleFactor: S.number({ min: 0.5, max: 8 }),
  }),
  "screenshot.cancelRegion": S.object({}),
  "screenshot.analyze": S.object({
    id: S.string({ min: 1, max: 120 }),
    note: S.string({ max: 2000 }).optional(),
    strategy: S.union([S.literal("auto"), S.literal("vision"), S.literal("extract")]).optional(),
  }),
  "screenshot.solve": S.object({
    groupId: S.string({ min: 1, max: 120 }),
    note: S.string({ max: 2000 }).optional(),
    strategy: S.union([S.literal("auto"), S.literal("vision"), S.literal("extract")]).optional(),
  }),
  "screenshot.retry": S.object({ groupId: S.string({ min: 1, max: 120 }) }),
  "screenshot.stopGroup": S.object({ groupId: S.string({ min: 1, max: 120 }) }),
  "screenshot.extractGroup": S.object({ groupId: S.string({ min: 1, max: 120 }) }),
  "screenshot.reopen": S.object({ groupId: S.string({ min: 1, max: 120 }) }),
  "screenshot.closeGroup": S.object({ groupId: S.string({ min: 1, max: 120 }) }),
  "screenshot.deleteGroup": S.object({ groupId: S.string({ min: 1, max: 120 }) }),
  "screenshot.archive": S.object({
    id: S.string({ min: 1, max: 120 }),
    guard: S.object({
      requestId: S.string({ min: 1, max: 120 }),
      screenshotContextId: S.string({ min: 1, max: 120 }),
      archiveRequestId: S.string({ min: 1, max: 120 }),
    }),
  }),
  "screenshot.read": S.object({ id: S.string({ min: 1, max: 120 }) }),
  "screenshot.delete": S.object({ id: S.string({ min: 1, max: 120 }) }),
  "screenshot.list": S.object({}),
  "kb.list": S.object({}),
  "kb.pickAndImport": S.object({}),
  "kb.importText": S.object({ name: S.string({ min: 1, max: 200 }), text: S.string({ min: 1, max: 5000000 }) }),
  "kb.delete": S.object({ id: S.string({ min: 1, max: 120 }) }),
  "kb.search": S.object({ query: S.string({ min: 1, max: 2000 }), topK: S.number({ integer: true, min: 1, max: 20 }).optional() }),
  "overlay.update": overlayPatchSchema,
  "overlay.toggle": S.object({}),
  "overlay.hide": S.object({}),
  "overlay.hover": S.object({ inside: S.boolean() }),
  "overlay.interaction": S.object({ active: S.boolean() }),
  "overlay.keyboard": S.object({ active: S.boolean() }),
  "overlay.hitRegions": S.object({
    regions: S.arrayOf(
      S.object({
        x: S.number({ min: 0, max: 20000 }),
        y: S.number({ min: 0, max: 20000 }),
        width: S.number({ min: 0, max: 20000 }),
        height: S.number({ min: 0, max: 20000 }),
      }),
      { max: 600 },
    ),
  }),
  "overlay.drag": S.object({
    phase: S.union([S.literal("start"), S.literal("move"), S.literal("end")]),
    dx: S.number({ integer: true, min: -20000, max: 20000 }).optional(),
    dy: S.number({ integer: true, min: -20000, max: 20000 }).optional(),
  }),
  "overlay.resize": S.object({
    width: S.number({ integer: true, min: 320, max: 4000 }),
    height: S.number({ integer: true, min: 260, max: 4000 }),
  }),
  "overlay.layout": S.object({ compact: S.boolean() }),
  "system.copyText": S.object({ text: S.string({ min: 1, max: 200000 }) }),
  "hotkey.status": S.object({}),
  "lock.status": S.object({}),
  "lock.unlock": S.object({ passcode: S.string({ min: 1, max: 64 }) }),
  "lock.set": S.object({ passcode: S.string({ min: 4, max: 64 }) }),
  "lock.clear": S.object({ passcode: S.string({ min: 1, max: 64 }) }),
} as const;

export type Channel = keyof typeof payloadSchemas;

export const EVENT_NAMES = [
  "state",
  "answer.delta",
  "answer.reset",
  "answer.done",
  "answer.error",
  "toast",
  "screenshot",
  "screenshot.stage",
  "transcribe.status",
  "transcribe.partial",
  "command",
] as const;

export type EventName = (typeof EVENT_NAMES)[number];

export type ServerEvents = {
  state: AppSnapshot;
  "answer.delta": { answerId: string; generationId: number; delta: string };
  "answer.reset": { answerId: string; generationId: number };
  "answer.done": { answerId: string; generationId: number };
  "answer.error": { answerId: string; message: string; cancelled: boolean };
  toast: { level: "info" | "success" | "warn" | "error"; message: string };
  screenshot: { meta: ScreenshotMeta; dataUrl: string };
  "screenshot.stage": {
    id: string;
    stage: "queued" | "extracting" | "solving" | "done" | "error" | "cancelled";
    route?: "vision" | "extract";
    message?: string;
  };
  "transcribe.status": {
    channel: "mic" | "system";
    state: "idle" | "connecting" | "capturing" | "listening" | "transcribing" | "error" | "done";
    message?: string;
  };
  "transcribe.partial": { channel: "mic" | "system"; text: string };
  command: { type: "toggle-listening" | "focus-ask" | "show-settings" };
};

export type ApiPayloads = {
  "app.snapshot": Record<string, never>;
  "app.ready": { renderer: string };
  "settings.update": AppSettings;
  "settings.reset": Record<string, never>;
  "secrets.status": Record<string, never>;
  "secrets.set": { key: SecretKey; value: string };
  "secrets.clear": { key: SecretKey };
  "providers.test": { service: "llm" | "transcription" | "vision" | "extraction" };
  "session.new": Record<string, never>;
  "session.load": { id: string };
  "session.list": Record<string, never>;
  "session.rename": { id?: string; title: string };
  "session.delete": { id: string };
  "session.clearSegments": Record<string, never>;
  "transcript.append": {
    speaker: Speaker;
    text: string;
    source?: "mic" | "system" | "manual";
    startMs?: number;
    endMs?: number;
  };
  "transcript.setSpeaker": { id: string; speaker: Speaker };
  "listening.update": { mic: boolean; system: boolean };
  "transcribe.audio": {
    channel: "mic" | "system";
    mimeType: string;
    data: ArrayBuffer | Uint8Array;
    startMs?: number;
    endMs?: number;
  };
  "transcribe.startRealtime": { channel: "mic" | "system" };
  "transcribe.pushPcm": { channel: "mic" | "system"; data: ArrayBuffer | Uint8Array };
  "transcribe.stopRealtime": { channel: "mic" | "system" };
  "trigger.manual": { text: string; ask: boolean };
  "answer.start": { question: string; trigger?: "manual" | "queue" | "knowledge" };
  "answer.cancel": { answerId: string };
  "answer.retry": { answerId: string };
  "queue.next": Record<string, never>;
  "queue.remove": { id: string };
  "queue.clear": Record<string, never>;
  "screenshot.captureFull": Record<string, never>;
  "screenshot.captureRegion": Record<string, never>;
  "screenshot.regionPreview": { displayId: string };
  "screenshot.regionReady": Record<string, never>;
  "screenshot.submitRegion": {
    displayId: string;
    rect: { x: number; y: number; width: number; height: number };
    scaleFactor: number;
  };
  "screenshot.cancelRegion": Record<string, never>;
  "screenshot.analyze": { id: string; note?: string; strategy?: "auto" | "vision" | "extract" };
  "screenshot.solve": { groupId: string; note?: string; strategy?: "auto" | "vision" | "extract" };
  "screenshot.retry": { groupId: string };
  "screenshot.stopGroup": { groupId: string };
  "screenshot.extractGroup": { groupId: string };
  "screenshot.reopen": { groupId: string };
  "screenshot.closeGroup": { groupId: string };
  "screenshot.deleteGroup": { groupId: string };
  "screenshot.extract": { id: string };
  "screenshot.continue": { id: string; previousAnswerId?: string; note?: string };
  "screenshot.archive": {
    id: string;
    guard: { requestId: string; screenshotContextId: string; archiveRequestId: string };
  };
  "screenshot.read": { id: string };
  "screenshot.delete": { id: string };
  "screenshot.list": Record<string, never>;
  "kb.list": Record<string, never>;
  "kb.pickAndImport": Record<string, never>;
  "kb.importText": { name: string; text: string };
  "kb.delete": { id: string };
  "kb.search": { query: string; topK?: number };
  "overlay.update": Partial<AppSettings["overlay"]>;
  "overlay.toggle": Record<string, never>;
  "overlay.hide": Record<string, never>;
  "overlay.hover": { inside: boolean };
  "overlay.interaction": { active: boolean };
  "overlay.keyboard": { active: boolean };
  "overlay.hitRegions": {
    regions: Array<{ x: number; y: number; width: number; height: number }>;
  };
  "overlay.drag": { phase: "start" | "move" | "end"; dx?: number; dy?: number };
  "overlay.resize": { width: number; height: number };
  "overlay.layout": { compact: boolean };
  "system.copyText": { text: string };
  "hotkey.status": Record<string, never>;
  "lock.status": Record<string, never>;
  "lock.unlock": { passcode: string };
  "lock.set": { passcode: string };
  "lock.clear": { passcode: string };
};

export type KbSearchHit = { docName: string; text: string; score: number };

export type ApiResults = {
  "app.snapshot": AppSnapshot;
  "app.ready": { ok: boolean };
  "settings.update": AppSnapshot;
  "settings.reset": AppSnapshot;
  "secrets.status": SecretsStatus;
  "secrets.set": SecretsStatus;
  "secrets.clear": SecretsStatus;
  "providers.test": { ok: boolean; message: string; latencyMs?: number };
  "session.new": AppSnapshot;
  "session.load": AppSnapshot;
  "session.list": SessionSummary[];
  "session.rename": AppSnapshot;
  "session.delete": AppSnapshot;
  "session.clearSegments": AppSnapshot;
  "transcript.append": { segment: TranscriptSegment; decision: TriggerDecision };
  "transcript.setSpeaker": AppSnapshot;
  "listening.update": AppSnapshot;
  "transcribe.audio": { text: string; segment?: TranscriptSegment };
  "transcribe.startRealtime": { started: boolean; state: "listening" };
  "transcribe.pushPcm": { accepted: boolean; buffered: number };
  "transcribe.stopRealtime": { stopped: boolean };
  "trigger.manual": { decision: TriggerDecision; answerId?: string };
  "answer.start": { answerId: string; queued?: boolean };
  "answer.cancel": { cancelled: boolean };
  "answer.retry": { answerId: string };
  "queue.next": { answerId: string | null };
  "queue.remove": AppSnapshot;
  "queue.clear": AppSnapshot;
  "screenshot.captureFull": { meta: ScreenshotMeta; dataUrl: string };
  "screenshot.captureRegion": { opened: boolean };
  "screenshot.regionPreview": {
    displayId: string;
    width: number;
    height: number;
    scaleFactor: number;
    dataUrl: string;
  };
  "screenshot.regionReady": { ready: boolean };
  "screenshot.submitRegion": { meta: ScreenshotMeta; dataUrl: string };
  "screenshot.cancelRegion": { closed: boolean };
  "screenshot.analyze": { answerId: string };
  "screenshot.solve": { answerId: string };
  "screenshot.retry": { answerId: string };
  "screenshot.stopGroup": { cancelled: boolean };
  "screenshot.extractGroup": { extracted: { problemStatement: string; additionalContext: string } };
  "screenshot.reopen": { opened: boolean };
  "screenshot.closeGroup": { closed: boolean };
  "screenshot.deleteGroup": { deleted: boolean };
  "screenshot.extract": { extracted: { problemStatement: string; additionalContext: string } };
  "screenshot.continue": { answerId: string };
  "screenshot.archive": ScreenshotMeta;
  "screenshot.read": { dataUrl: string };
  "screenshot.delete": { deleted: boolean };
  "screenshot.list": ScreenshotMeta[];
  "kb.list": { docCount: number; chunkCount: number; docs: KnowledgeDoc[] };
  "kb.pickAndImport": { imported: number; summary: { docCount: number; chunkCount: number; docs: KnowledgeDoc[] } };
  "kb.importText": { imported: number; docId: string; summary: { docCount: number; chunkCount: number; docs: KnowledgeDoc[] } };
  "kb.delete": { docCount: number; chunkCount: number; docs: KnowledgeDoc[] };
  "kb.search": { hits: KbSearchHit[] };
  "overlay.update": AppSnapshot;
  "overlay.toggle": AppSnapshot;
  "overlay.hide": { hidden: boolean };
  "overlay.hover": { clickThrough: boolean };
  "overlay.interaction": { active: boolean };
  "overlay.keyboard": { active: boolean; focusable: boolean };
  "overlay.hitRegions": { regions: number };
  "overlay.drag": { moved: boolean };
  "overlay.resize": { width: number; height: number };
  "overlay.layout": { compact: boolean; width: number; height: number };
  "system.copyText": { copied: boolean };
  "hotkey.status": {
    platform: string;
    registrations: Array<{
      action: string;
      requested: string;
      accelerator: string;
      registered: boolean;
      active: boolean;
      reason: "empty" | "invalid" | "duplicate" | "occupied" | null;
    }>;
  };
  "lock.status": { enabled: boolean; unlocked: boolean };
  "lock.unlock": { unlocked: boolean; remaining: number };
  "lock.set": { enabled: boolean };
  "lock.clear": { enabled: boolean };
};

export type PayloadOf<C extends Channel> = C extends keyof ApiPayloads ? ApiPayloads[C] : Record<string, never>;
export type ResultOf<C extends Channel> = C extends keyof ApiResults ? ApiResults[C] : unknown;

export function validatePayload(channel: Channel, payload: unknown): unknown {
  const schema = payloadSchemas[channel] as Validator<unknown>;
  return S.validate(schema, payload ?? {});
}

export function isChannel(value: unknown): value is Channel {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(payloadSchemas, value);
}

export type { AppSnapshot, AppSettings, Session, SessionSummary, TranscriptSegment, ScreenshotMeta, ArchiveState };
