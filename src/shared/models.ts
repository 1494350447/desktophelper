import { defaultHotkeys, type HotkeySettings } from "./hotkeys.ts";

export type { HotkeySettings } from "./hotkeys.ts";

export type Speaker = "me" | "interviewer";
export type SegmentSource = "mic" | "system" | "manual";
export type AnswerStatus = "streaming" | "done" | "error" | "cancelled";
export type AnswerTrigger = "auto" | "manual" | "queue" | "screenshot" | "knowledge";
export type ProviderKind = "mock" | "openai" | "dashscope" | "dashscope-http";
export type TranscriptionMode = "batch" | "realtime";
export type SecretKey = "llm" | "transcription" | "vision" | "extraction";
export type SystemStyle = "concise" | "detailed" | "star";
export type TargetSpeaker = "interviewer" | "me" | "both";
export type ArchiveState = "pending" | "archived" | "failed";
export type ScreenshotStrategy = "auto" | "vision" | "extract";
export type ScreenshotStage =
  | "idle"
  | "queued"
  | "extracting"
  | "solving"
  | "done"
  | "error"
  | "cancelled";
export type ScreenshotRoute = "vision" | "extract";
export type CaptureGroupStatus = "collecting" | "answering" | "answered" | "error" | "closed";
export type AnswerLane = "voice" | "screenshot";

export type TranscriptSegment = {
  id: string;
  speaker: Speaker;
  text: string;
  source: SegmentSource;
  startMs: number;
  endMs: number;
  final: boolean;
  createdAt: number;
};

export type Answer = {
  id: string;
  generationId: number;
  question: string;
  trigger: AnswerTrigger;
  lane: AnswerLane;
  status: AnswerStatus;
  text: string;
  error?: string;
  model?: string;
  citedDocs?: string[];
  screenshotId?: string;
  groupId?: string;
  screenshotIds?: string[];
  createdAt: number;
  updatedAt: number;
};

export type CaptureGroup = {
  id: string;
  seq: number;
  sessionId: string;
  createdAt: number;
  updatedAt: number;
  status: CaptureGroupStatus;
  screenshotIds: string[];
  answerId: string | null;
  answerIds: string[];
  solvedShotCount?: number;
  lastError?: string;
};

export type QueuedQuestion = {
  id: string;
  speaker: Speaker;
  text: string;
  createdAt: number;
  reason: string;
  lane: AnswerLane;
};

export type Session = {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  segments: TranscriptSegment[];
  answers: Answer[];
  queue: QueuedQuestion[];
  inflightAnswerId: string | null;
  inflightQuestion: string | null;
  inflightScreenshotAnswerId: string | null;
  inflightScreenshotQuestion: string | null;
  lastTriggerAt: number | null;
  recentTriggers: Array<{ normalized: string; at: number }>;
  archived: boolean;
};

export type SessionSummary = {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  segmentCount: number;
  answerCount: number;
  archived: boolean;
};

export type ProviderSettings = {
  provider: ProviderKind;
  baseUrl: string;
  model: string;
};

export type TranscriptionSettings = ProviderSettings & {
  language: string;
  chunkSeconds: number;
  mode: TranscriptionMode;
};

export const DASHSCOPE_REALTIME_BASE_URL = "wss://dashscope.aliyuncs.com/api-ws/v1/inference";
export const DASHSCOPE_ASR_MODEL = "qwen-audio-3.1-asr-flash-streaming";
export const DASHSCOPE_ASR_LANGUAGE = "zh";
export const DASHSCOPE_HTTP_ENDPOINT =
  "https://llm-rq2mbn4f2z2pilqa.cn-beijing.maas.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation";
export const DASHSCOPE_HTTP_MODEL = "qwen-audio-3.1-asr-flash";
export const DASHSCOPE_HTTP_SAMPLE_RATE = 16000;

export type LlmSettings = ProviderSettings & {
  temperature: number;
  maxTokens: number;
  systemStyle: SystemStyle;
};

export type VisionSettings = ProviderSettings & {
  maxTokens: number;
  useLlm: boolean;
};

export type ExtractionSettings = ProviderSettings & {
  maxTokens: number;
  useLlm: boolean;
};

export type ScreenshotSettings = {
  strategy: ScreenshotStrategy;
  fallbackToExtract: boolean;
  maxImages: number;
};

export type TriggerSettings = {
  autoAnswer: boolean;
  minChars: number;
  targetSpeaker: TargetSpeaker;
  throttleMs: number;
  dedupeWindowMs: number;
  autoDrainQueue: boolean;
  maxAnswers: number;
};

export type OverlaySettings = {
  opacity: number;
  fontSize: number;
  clickThrough: boolean;
  compact: boolean;
  alwaysOnTop: boolean;
  bounds: { x: number; y: number; width: number; height: number } | null;
};

export type KnowledgeSettings = {
  enabled: boolean;
  topK: number;
  maxFileBytes: number;
  chunkSize: number;
  chunkOverlap: number;
};

export type PrivacySettings = {
  storeTranscripts: boolean;
  lockEnabled: boolean;
  excludeFromCapture: boolean;
};

export type VoiceSettings = {
  captureSystemAudio: boolean;
  micSpeaker: Speaker;
  systemSpeaker: Speaker;
};

export type AppSettings = {
  version: number;
  transcription: TranscriptionSettings;
  llm: LlmSettings;
  vision: VisionSettings;
  extraction: ExtractionSettings;
  screenshot: ScreenshotSettings;
  trigger: TriggerSettings;
  overlay: OverlaySettings;
  kb: KnowledgeSettings;
  privacy: PrivacySettings;
  voice: VoiceSettings;
  hotkeys: HotkeySettings;
};

export type SecretsStatus = {
  llm: boolean;
  transcription: boolean;
  vision: boolean;
  extraction: boolean;
  lock: boolean;
};

export type ExtractedProblem = {
  problemStatement: string;
  additionalContext: string;
};

export type ScreenshotAnalysis = {
  status: "idle" | "streaming" | "done" | "error";
  stage?: ScreenshotStage;
  route?: ScreenshotRoute;
  answerId?: string;
  text?: string;
  error?: string;
  extracted?: ExtractedProblem;
  extractionModel?: string;
  solutionModel?: string;
  continuationOfAnswerId?: string;
  sourceScreenshotIds?: string[];
  startedAt?: number;
  updatedAt?: number;
};

export type ScreenshotMeta = {
  id: string;
  createdAt: number;
  mode: "full" | "region";
  width: number;
  height: number;
  file: string;
  displayId: string;
  requestId: string;
  screenshotContextId: string;
  archiveRequestId: string;
  archiveState: ArchiveState;
  archiveAttempts: number;
  archiveError?: string;
  archivedPath?: string;
  analysis: ScreenshotAnalysis;
};

export type KnowledgeDoc = {
  id: string;
  name: string;
  sourcePath: string;
  bytes: number;
  chunks: number;
  createdAt: number;
};

export type KnowledgeChunk = {
  id: string;
  docId: string;
  docName: string;
  index: number;
  text: string;
};

export type KnowledgeBase = {
  version: number;
  docs: KnowledgeDoc[];
  chunks: KnowledgeChunk[];
};

export type KbSummary = {
  docCount: number;
  chunkCount: number;
  docs: KnowledgeDoc[];
};

export type ListeningState = {
  mic: boolean;
  system: boolean;
};

export type AppSnapshot = {
  appVersion: string;
  dataDir: string;
  settings: AppSettings;
  session: Session;
  sessions: SessionSummary[];
  secrets: SecretsStatus;
  screenshots: ScreenshotMeta[];
  groups: CaptureGroup[];
  kb: KbSummary;
  listening: ListeningState;
  lock: { enabled: boolean; unlocked: boolean };
  warnings: string[];
};

export function defaultSettings(): AppSettings {
  return {
    version: 5,
    transcription: {
      provider: "openai",
      baseUrl: "https://api.openai.com/v1",
      model: "whisper-1",
      language: "zh",
      chunkSeconds: 12,
      mode: "batch",
    },
    llm: {
      provider: "mock",
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-4o-mini",
      temperature: 0.4,
      maxTokens: 4096,
      systemStyle: "concise",
    },
    vision: {
      provider: "mock",
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-4o-mini",
      maxTokens: 4096,
      useLlm: false,
    },
    extraction: {
      provider: "mock",
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-4o-mini",
      maxTokens: 4096,
      useLlm: false,
    },
    screenshot: {
      strategy: "auto",
      fallbackToExtract: true,
      maxImages: 3,
    },
    trigger: {
      autoAnswer: true,
      minChars: 6,
      targetSpeaker: "interviewer",
      throttleMs: 6000,
      dedupeWindowMs: 20000,
      autoDrainQueue: true,
      maxAnswers: 5,
    },
    overlay: {
      opacity: 0.86,
      fontSize: 14,
      clickThrough: true,
      compact: true,
      alwaysOnTop: true,
      bounds: null,
    },
    kb: {
      enabled: false,
      topK: 4,
      maxFileBytes: 2000000,
      chunkSize: 700,
      chunkOverlap: 120,
    },
    privacy: {
      storeTranscripts: true,
      lockEnabled: false,
      excludeFromCapture: true,
    },
    voice: {
      captureSystemAudio: true,
      micSpeaker: "me",
      systemSpeaker: "interviewer",
    },
    hotkeys: defaultHotkeys(),
  };
}

export function emptySession(id: string, now: number): Session {
  return {
    id,
    title: "新的会话",
    createdAt: now,
    updatedAt: now,
    segments: [],
    answers: [],
    queue: [],
    inflightAnswerId: null,
    inflightQuestion: null,
    inflightScreenshotAnswerId: null,
    inflightScreenshotQuestion: null,
    lastTriggerAt: null,
    recentTriggers: [],
    archived: false,
  };
}

export function emptyKnowledgeBase(): KnowledgeBase {
  return { version: 1, docs: [], chunks: [] };
}

export function summarizeSession(session: Session): SessionSummary {
  return {
    id: session.id,
    title: session.title,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    segmentCount: session.segments.length,
    answerCount: session.answers.length,
    archived: session.archived,
  };
}

export function cloneSettings(settings: AppSettings): AppSettings {
  return JSON.parse(JSON.stringify(settings)) as AppSettings;
}
