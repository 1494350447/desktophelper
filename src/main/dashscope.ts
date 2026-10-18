import { randomUUID } from "node:crypto";
import {
  DASHSCOPE_ASR_MODEL,
  DASHSCOPE_REALTIME_BASE_URL,
} from "../shared/models.ts";
import type { ProviderTestResult } from "./providers.ts";
import { AppError } from "../shared/result.ts";
import { connectWebSocket, type WebSocketLike } from "./websocket.ts";

export const DASHSCOPE_DEFAULT_SAMPLE_RATE = 16000;
const MAX_PENDING_BYTES = 2 * 1024 * 1024;
const MAX_SOCKET_BUFFER_BYTES = 4 * 1024 * 1024;

export type RealtimeStatus = "connecting" | "listening" | "error" | "done";

export type RealtimeFinalResult = {
  text: string;
  startMs?: number;
  endMs?: number;
};

export type DashScopeSessionOptions = {
  url: string;
  apiKey: string;
  model: string;
  language: string;
  sampleRate?: number;
  connectTimeoutMs?: number;
  heartbeatMs?: number;
  stopFlushMs?: number;
  createSocket?: (url: string, headers: Record<string, string>, timeoutMs: number) => Promise<WebSocketLike>;
  now?: () => number;
  createTaskId?: () => string;
  onStatus: (state: RealtimeStatus, message?: string) => void;
  onPartial: (text: string) => void;
  onFinal: (result: RealtimeFinalResult) => void;
  onError: (message: string) => void;
};

export type RealtimeTranscriptionSession = {
  readonly bufferedBytes: number;
  start: () => Promise<void>;
  push: (pcm: Uint8Array) => void;
  stop: () => Promise<void>;
  dispose: () => void;
};

export type DashScopeEvent =
  | { kind: "started"; taskId?: string }
  | { kind: "partial"; text: string; id?: string; startMs?: number; endMs?: number }
  | { kind: "final"; text: string; id?: string; startMs?: number; endMs?: number }
  | { kind: "finished"; taskId?: string }
  | { kind: "failed"; message: string; code?: string }
  | { kind: "ignored" };

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function firstText(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value !== "string") continue;
    const text = value.trim();
    if (text) return text;
  }
  return "";
}

function firstNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  }
  return undefined;
}

function flag(value: unknown): boolean {
  return value === true || value === 1 || value === "true" || value === "1";
}

function timeRange(value: unknown): { startMs?: number; endMs?: number } {
  if (Array.isArray(value)) {
    return {
      startMs: firstNumber(value[0]),
      endMs: firstNumber(value[1]),
    };
  }
  const record = asRecord(value);
  if (!record) return {};
  return {
    startMs: firstNumber(record.begin_time, record.beginTime, record.start_time, record.startTime, record.start_ms, record.startMs),
    endMs: firstNumber(record.end_time, record.endTime, record.stop_time, record.stopTime, record.end_ms, record.endMs),
  };
}

function nestedText(value: unknown): string {
  const record = asRecord(value);
  if (!record) return "";
  return firstText(record.message, record.msg, record.detail, record.code);
}

export function normalizeDashScopeLanguage(value: string): string {
  const trimmed = value.trim();
  const key = trimmed.toLowerCase().replace("_", "-");
  const aliases: Record<string, string> = {
    zh: "zh",
    "zh-cn": "zh",
    "zh-hans": "zh",
    "zh-hant": "zh",
    cmn: "zh",
    chinese: "zh",
    yue: "zh",
    en: "en",
    "en-us": "en",
    "en-gb": "en",
    english: "en",
    ja: "ja",
    "ja-jp": "ja",
    japanese: "ja",
    ko: "ko",
    "ko-kr": "ko",
    korean: "ko",
  };
  if (!key || key === "auto") return "";
  return aliases[key] ?? key.split("-")[0] ?? trimmed;
}

export function resolveDashScopeUrl(value: string): string {
  const trimmed = value.trim();
  if (/^wss?:\/\//i.test(trimmed)) return trimmed;
  if (/^https?:\/\//i.test(trimmed)) return trimmed.replace(/^http/i, "ws");
  return DASHSCOPE_REALTIME_BASE_URL;
}

export function dashScopeHeaders(apiKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
    "User-Agent": "Desktophelper/0.1",
  };
}

export function describeDashScopeError(message: string): string {
  const text = message.trim() || "未知错误";
  if (/InvalidAuthentication|Forbidden|unauthorized|authentication|HTTP\s*401|HTTP\s*403/i.test(text)) {
    return `DashScope 鉴权失败，请检查转写 API Key（${text}）`;
  }
  if (/model|InvalidParameter|invalid.*(format|sample|language)|not\s+found/i.test(text)) {
    return `DashScope 模型或参数不可用：${text}`;
  }
  return `DashScope 实时转写失败：${text}`;
}

export function buildRunTaskMessage(input: {
  taskId: string;
  model: string;
  language: string;
  sampleRate?: number;
}): string {
  const language = normalizeDashScopeLanguage(input.language);
  const parameters: Record<string, unknown> = {
    format: "pcm",
    sample_rate: input.sampleRate ?? DASHSCOPE_DEFAULT_SAMPLE_RATE,
    heartbeat: true,
  };
  if (language) parameters.language_hints = [language];
  return JSON.stringify({
    header: {
      action: "run-task",
      task_id: input.taskId,
      streaming: "duplex",
    },
    payload: {
      task_group: "audio",
      task: "asr",
      function: "recognition",
      model: input.model,
      parameters,
      input: {},
    },
  });
}

export function buildFinishTaskMessage(taskId: string): string {
  return JSON.stringify({
    header: {
      action: "finish-task",
      task_id: taskId,
      streaming: "duplex",
    },
    payload: { input: {} },
  });
}

export function parseDashScopeMessage(raw: string): DashScopeEvent | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const root = asRecord(parsed);
  if (!root) return null;
  const header = asRecord(root.header) ?? {};
  const payload = asRecord(root.payload) ?? {};
  const event = firstText(header.event).toLowerCase();
  const taskId = firstText(header.task_id, header.taskId) || undefined;

  if (event === "task-started" || event === "task_started") return { kind: "started", taskId };
  if (event === "task-finished" || event === "task_finished") return { kind: "finished", taskId };
  if (event === "task-failed" || event === "task_failed") {
    const code = firstText(header.error_code, header.errorCode, payload.code) || undefined;
    const message =
      firstText(
        header.error_message,
        header.errorMessage,
        nestedText(payload.error),
        nestedText(payload.output),
        payload.message,
      ) || code || "未知错误";
    return { kind: "failed", message, code };
  }

  const rawOutput = Array.isArray(payload.output) ? payload.output[0] : payload.output;
  const output = asRecord(rawOutput) ?? payload;
  const sentence =
    asRecord(output.sentence) ?? asRecord(output.result) ?? asRecord(output.utterance) ?? output;
  if (flag(sentence.heartbeat) || flag(output.heartbeat) || flag(payload.heartbeat)) {
    return { kind: "ignored" };
  }
  const text = firstText(
    sentence.transcription,
    sentence.text,
    sentence.recognized,
    sentence.result,
    output.transcription,
    output.text,
    output.recognized,
  );
  if (!text) return { kind: "ignored" };

  const final =
    flag(sentence.sentence_end) ||
    flag(sentence.sentenceEnd) ||
    flag(sentence.is_final) ||
    flag(sentence.isFinal) ||
    flag(output.sentence_end) ||
    flag(output.sentenceEnd) ||
    flag(output.is_final) ||
    flag(output.isFinal);
  const numericId = firstNumber(sentence.sentence_id, sentence.sentenceId);
  const id =
    numericId !== undefined
      ? String(numericId)
      : firstText(sentence.sentence_id, sentence.sentenceId, sentence.id) || undefined;
  const range = timeRange(sentence.timestamp ?? output.timestamp);
  const startMs = firstNumber(
    sentence.begin_time,
    sentence.beginTime,
    sentence.start_time,
    sentence.startTime,
    sentence.start_ms,
    sentence.startMs,
  ) ?? range.startMs;
  const endMs = firstNumber(
    sentence.end_time,
    sentence.endTime,
    sentence.stop_time,
    sentence.stopTime,
    sentence.end_ms,
    sentence.endMs,
  ) ?? range.endMs;
  return { kind: final ? "final" : "partial", text, id, startMs, endMs };
}

export class DashScopeRealtimeSession implements RealtimeTranscriptionSession {
  private readonly options: DashScopeSessionOptions;
  private readonly connectTimeoutMs: number;
  private readonly heartbeatMs: number;
  private readonly stopFlushMs: number;
  private readonly now: () => number;
  private readonly taskId: string;
  private readonly sampleRate: number;

  private socket: WebSocketLike | null = null;
  private phase: "idle" | "connecting" | "ready" | "stopping" | "stopped" = "idle";
  private started = false;
  private failure = "";
  private pending: Buffer[] = [];
  private pendingBytes = 0;
  private heartbeat: ReturnType<typeof setTimeout> | null = null;
  private startTimer: ReturnType<typeof setTimeout> | null = null;
  private stopTimer: ReturnType<typeof setTimeout> | null = null;
  private stopPromise: Promise<void> | null = null;
  private stopResolve: (() => void) | null = null;
  private lastPartial = "";
  private lastFinalText = "";
  private lastFinalAt = 0;
  private finalizedIds = new Set<string>();

  constructor(options: DashScopeSessionOptions) {
    this.options = options;
    this.connectTimeoutMs = Math.max(1000, options.connectTimeoutMs ?? 10000);
    this.heartbeatMs = Math.max(1000, options.heartbeatMs ?? 10000);
    this.stopFlushMs = Math.max(200, options.stopFlushMs ?? 3000);
    this.now = options.now ?? (() => Date.now());
    this.taskId = (options.createTaskId ?? (() => randomUUID()))();
    this.sampleRate = options.sampleRate ?? DASHSCOPE_DEFAULT_SAMPLE_RATE;
  }

  get bufferedBytes(): number {
    return this.pendingBytes + (this.socket?.bufferedAmount ?? 0);
  }

  async start(): Promise<void> {
    if (this.phase !== "idle") throw new AppError("CONFLICT", "实时转写会话已启动");
    this.phase = "connecting";
    this.options.onStatus("connecting");
    const url = resolveDashScopeUrl(this.options.url);
    const createSocket =
      this.options.createSocket ??
      ((target: string, headers: Record<string, string>, timeoutMs: number) =>
        connectWebSocket(target, { headers, handshakeTimeoutMs: timeoutMs }));
    try {
      this.socket = await createSocket(url, dashScopeHeaders(this.options.apiKey), this.connectTimeoutMs);
    } catch (error) {
      const message = describeDashScopeError(error instanceof Error ? error.message : String(error));
      this.fail(message);
      throw new AppError(
        /鉴权失败/.test(message) ? "UNAUTHORIZED" : "NETWORK",
        message,
      );
    }
    this.bindSocket();
    const sent = this.socket.sendText(
      buildRunTaskMessage({
        taskId: this.taskId,
        model: this.options.model || DASHSCOPE_ASR_MODEL,
        language: normalizeDashScopeLanguage(this.options.language),
        sampleRate: this.sampleRate,
      }),
    );
    if (!sent) {
      this.fail("无法发送实时转写启动请求");
      throw new AppError("NETWORK", "无法发送实时转写启动请求");
    }
    this.heartbeat = setInterval(() => this.beat(), this.heartbeatMs);
    if (typeof (this.heartbeat as { unref?: () => void }).unref === "function") {
      (this.heartbeat as { unref: () => void }).unref();
    }
    this.startTimer = setTimeout(() => {
      if (!this.started && !this.failure) this.fail("实时转写服务未在限定时间内响应");
    }, this.connectTimeoutMs);
    if (typeof (this.startTimer as { unref?: () => void }).unref === "function") {
      (this.startTimer as { unref: () => void }).unref();
    }
  }

  push(pcm: Uint8Array): void {
    if (pcm.byteLength === 0 || this.phase === "stopping" || this.phase === "stopped") return;
    if (!this.started) {
      this.pendingBytes += pcm.byteLength;
      if (this.pendingBytes > MAX_PENDING_BYTES) {
        this.fail("实时转写启动超时，音频缓冲已满");
        return;
      }
      this.pending.push(Buffer.from(pcm));
      return;
    }
    this.sendBinary(pcm);
  }

  stop(): Promise<void> {
    if (this.phase === "stopped") return Promise.resolve();
    if (this.stopPromise) return this.stopPromise;
    this.stopPromise = new Promise<void>((resolve) => {
      this.stopResolve = resolve;
    });
    this.phase = "stopping";
    this.clearStartTimer();
    if (!this.socket || !this.started) {
      this.finishStop();
      return this.stopPromise;
    }
    this.flushPending();
    if (!this.socket.sendText(buildFinishTaskMessage(this.taskId))) {
      this.fail("实时转写连接已断开");
      this.finishStop();
      return this.stopPromise;
    }
    this.stopTimer = setTimeout(() => this.finishStop(), this.stopFlushMs);
    if (typeof (this.stopTimer as { unref?: () => void }).unref === "function") {
      (this.stopTimer as { unref: () => void }).unref();
    }
    return this.stopPromise;
  }

  dispose(): void {
    if (this.phase === "stopped") return;
    this.phase = "stopped";
    this.clearTimers();
    const socket = this.socket;
    this.socket = null;
    try {
      socket?.terminate();
    } catch {
      // ignore cleanup failures
    }
    this.stopResolve?.();
    this.stopResolve = null;
  }

  private bindSocket(): void {
    const socket = this.socket;
    if (!socket) return;
    socket.onMessage((data) => {
      if (typeof data !== "string") return;
      const event = parseDashScopeMessage(data);
      if (event) this.handleEvent(event);
    });
    socket.onError((error) => {
      this.fail(`实时转写连接错误：${error.message}`);
    });
    socket.onClose((code, reason) => {
      if (this.phase === "stopping" || this.phase === "stopped") {
        this.finishStop();
        return;
      }
      if (this.failure) return;
      const detail = reason ? `：${reason}` : "";
      this.fail(`实时转写连接已断开（${code}）${detail}`);
    });
  }

  private handleEvent(event: DashScopeEvent): void {
    if (event.kind === "started") {
      if (this.started) return;
      this.started = true;
      this.clearStartTimer();
      this.options.onStatus("listening");
      this.flushPending();
      return;
    }
    if (event.kind === "failed") {
      this.fail(describeDashScopeError(event.code ? `${event.code}: ${event.message}` : event.message));
      return;
    }
    if (event.kind === "finished") {
      this.finishStop();
      return;
    }
    if (event.kind === "ignored") return;
    if (event.kind === "partial") {
      if (event.text === this.lastPartial) return;
      this.lastPartial = event.text;
      this.options.onPartial(event.text);
      return;
    }
    if (event.kind === "final") {
      const at = this.now();
      if (event.id && this.finalizedIds.has(event.id)) return;
      if (event.id) this.finalizedIds.add(event.id);
      if (!event.id && event.text === this.lastFinalText && at - this.lastFinalAt < 400) return;
      this.lastFinalText = event.text;
      this.lastFinalAt = at;
      this.lastPartial = "";
      this.options.onPartial("");
      this.options.onFinal({ text: event.text, startMs: event.startMs, endMs: event.endMs });
    }
  }

  private sendBinary(pcm: Uint8Array): void {
    const socket = this.socket;
    if (!socket) {
      this.fail("实时转写连接已断开");
      return;
    }
    if (socket.bufferedAmount > MAX_SOCKET_BUFFER_BYTES) {
      this.fail("实时转写网络拥塞，音频发送积压过多");
      return;
    }
    if (!socket.sendBinary(pcm)) this.fail("实时转写连接已断开");
  }

  private flushPending(): void {
    if (this.pending.length === 0) return;
    const chunks = this.pending;
    this.pending = [];
    this.pendingBytes = 0;
    for (const chunk of chunks) this.sendBinary(new Uint8Array(chunk));
  }

  private beat(): void {
    if (!this.socket) return;
    if (this.socket.readyState !== 1) {
      this.fail("实时转写连接已断开");
      return;
    }
    this.socket.ping();
  }

  private fail(message: string): void {
    if (this.failure) return;
    this.failure = message;
    this.clearTimers();
    this.options.onError(message);
    this.options.onStatus("error", message);
    this.finishStop();
  }

  private finishStop(): void {
    if (this.phase === "stopped") return;
    this.phase = "stopped";
    this.clearTimers();
    const socket = this.socket;
    this.socket = null;
    try {
      socket?.close(1000, "client stop");
    } catch {
      // ignore cleanup failures
    }
    if (!this.failure) this.options.onStatus("done");
    this.stopResolve?.();
    this.stopResolve = null;
  }

  private clearTimers(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    if (this.startTimer) clearTimeout(this.startTimer);
    if (this.stopTimer) clearTimeout(this.stopTimer);
    this.heartbeat = null;
    this.startTimer = null;
    this.stopTimer = null;
  }

  private clearStartTimer(): void {
    if (this.startTimer) clearTimeout(this.startTimer);
    this.startTimer = null;
  }
}

export async function probeDashScopeRealtime(options: {
  url: string;
  apiKey: string;
  model: string;
  language: string;
  timeoutMs?: number;
}): Promise<ProviderTestResult> {
  const started = Date.now();
  const timeoutMs = Math.max(2000, options.timeoutMs ?? 10000);
  let socket: WebSocketLike | null = null;
  try {
    socket = await connectWebSocket(resolveDashScopeUrl(options.url), {
      headers: dashScopeHeaders(options.apiKey),
      handshakeTimeoutMs: timeoutMs,
    });
    const taskId = randomUUID();
    const outcome = await new Promise<string | null>((resolve) => {
      let settled = false;
      const finish = (error: string | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(error);
      };
      const timer = setTimeout(() => finish("实时服务未在限定时间内响应"), timeoutMs);
      if (typeof (timer as { unref?: () => void }).unref === "function") {
        (timer as { unref: () => void }).unref();
      }
      socket!.onMessage((data) => {
        if (typeof data !== "string") return;
        const event = parseDashScopeMessage(data);
        if (!event) return;
        if (event.kind === "started") finish(null);
        if (event.kind === "failed") {
          finish(describeDashScopeError(event.code ? `${event.code}: ${event.message}` : event.message));
        }
      });
      socket!.onError((error) => finish(error.message));
      socket!.onClose((code, reason) => finish(`连接已关闭（${code}）${reason ? `：${reason}` : ""}`));
      socket!.sendText(
        buildRunTaskMessage({
          taskId,
          model: options.model || DASHSCOPE_ASR_MODEL,
          language: normalizeDashScopeLanguage(options.language),
        }),
      );
    });
    const latencyMs = Date.now() - started;
    if (outcome) return { ok: false, message: describeDashScopeError(outcome), latencyMs };
    socket.sendText(buildFinishTaskMessage(taskId));
    return { ok: true, message: "连接成功（实时语音识别可用）", latencyMs };
  } catch (error) {
    return {
      ok: false,
      message: describeDashScopeError(error instanceof Error ? error.message : String(error)),
      latencyMs: Date.now() - started,
    };
  } finally {
    try {
      socket?.close(1000, "probe");
    } catch {
      // ignore cleanup failures
    }
  }
}
