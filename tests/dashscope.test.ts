import test from "node:test";
import assert from "node:assert/strict";
import {
  buildFinishTaskMessage,
  buildRunTaskMessage,
  DashScopeRealtimeSession,
  normalizeDashScopeLanguage,
  parseDashScopeMessage,
  resolveDashScopeUrl,
} from "../src/main/dashscope.ts";
import type { WebSocketData, WebSocketLike } from "../src/main/websocket.ts";

class FakeSocket implements WebSocketLike {
  readyState = 1;
  bufferedAmount = 0;
  text: string[] = [];
  binary: Uint8Array[] = [];
  pingCount = 0;
  closed = false;

  private messageListeners = new Set<(data: WebSocketData) => void>();
  private closeListeners = new Set<(code: number, reason: string) => void>();
  private errorListeners = new Set<(error: Error) => void>();
  private openListeners = new Set<() => void>();

  sendText(text: string): boolean {
    this.text.push(text);
    return true;
  }

  sendBinary(data: Uint8Array): boolean {
    this.binary.push(data);
    return true;
  }

  ping(): void {
    this.pingCount += 1;
  }

  close(code = 1000, reason = ""): void {
    if (this.closed) return;
    this.closed = true;
    this.readyState = 3;
    for (const listener of this.closeListeners) listener(code, reason);
  }

  terminate(): void {
    this.close(1006, "terminated");
  }

  onOpen(listener: () => void): () => void {
    this.openListeners.add(listener);
    return () => this.openListeners.delete(listener);
  }

  onMessage(listener: (data: WebSocketData) => void): () => void {
    this.messageListeners.add(listener);
    return () => this.messageListeners.delete(listener);
  }

  onClose(listener: (code: number, reason: string) => void): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  onError(listener: (error: Error) => void): () => void {
    this.errorListeners.add(listener);
    return () => this.errorListeners.delete(listener);
  }

  emit(raw: string): void {
    for (const listener of this.messageListeners) listener(raw);
  }

  emitError(error: Error): void {
    for (const listener of this.errorListeners) listener(error);
  }
}

function startedEvent(): string {
  return JSON.stringify({ header: { event: "task-started", task_id: "task-1" }, payload: {} });
}

function resultEvent(text: string, final: boolean, id = "s1"): string {
  return JSON.stringify({
    header: { event: "result-generated", task_id: "task-1" },
    payload: {
      output: {
        sentence: {
          sentence_id: id,
          text,
          sentence_end: final,
          begin_time: 120,
          end_time: final ? 900 : 600,
        },
      },
    },
  });
}

test("run-task message carries the duplex ASR contract", () => {
  const message = JSON.parse(
    buildRunTaskMessage({ taskId: "task-1", model: "qwen-audio-3.1-asr-flash-streaming", language: "zh-CN" }),
  );
  assert.equal(message.header.action, "run-task");
  assert.equal(message.header.task_id, "task-1");
  assert.equal(message.header.streaming, "duplex");
  assert.equal(message.payload.task_group, "audio");
  assert.equal(message.payload.task, "asr");
  assert.equal(message.payload.function, "recognition");
  assert.equal(message.payload.model, "qwen-audio-3.1-asr-flash-streaming");
  assert.equal(message.payload.parameters.format, "pcm");
  assert.equal(message.payload.parameters.sample_rate, 16000);
  assert.deepEqual(message.payload.parameters.language_hints, ["zh"]);
  assert.equal(message.payload.parameters.heartbeat, true);
  assert.equal(message.payload.parameters.language, undefined);
  assert.deepEqual(message.payload.input, {});

  const finish = JSON.parse(buildFinishTaskMessage("task-1"));
  assert.equal(finish.header.action, "finish-task");
  assert.equal(finish.header.task_id, "task-1");
});

test("DashScope result parsing distinguishes partial and final sentences", () => {
  const partial = parseDashScopeMessage(resultEvent("你好", false));
  assert.deepEqual(partial, { kind: "partial", text: "你好", id: "s1", startMs: 120, endMs: 600 });

  const final = parseDashScopeMessage(resultEvent("你好世界", true));
  assert.equal(final?.kind, "final");
  assert.equal(final?.text, "你好世界");
  assert.equal(final?.endMs, 900);

  const timestamped = parseDashScopeMessage(
    JSON.stringify({
      header: { event: "result-generated" },
      payload: { output: [{ sentence: { text: "数组输出", isFinal: true, timestamp: [10, 20] } }] },
    }),
  );
  assert.deepEqual(timestamped, { kind: "final", text: "数组输出", id: undefined, startMs: 10, endMs: 20 });

  const numeric = parseDashScopeMessage(
    JSON.stringify({
      header: { event: "result-generated" },
      payload: { output: { sentence: { sentence_id: 3, text: "数字编号", sentence_end: true } } },
    }),
  );
  assert.deepEqual(numeric, { kind: "final", text: "数字编号", id: "3", startMs: undefined, endMs: undefined });

  const heartbeat = parseDashScopeMessage(
    JSON.stringify({
      header: { event: "result-generated" },
      payload: { output: { sentence: { sentence_id: 0, heartbeat: true, text: "" } } },
    }),
  );
  assert.deepEqual(heartbeat, { kind: "ignored" });
});

test("DashScope task-failed parsing keeps the provider code", () => {
  const event = parseDashScopeMessage(
    JSON.stringify({
      header: { event: "task-failed", error_code: "InvalidAuthentication", error_message: "Invalid API-key" },
      payload: {},
    }),
  );
  assert.deepEqual(event, { kind: "failed", message: "Invalid API-key", code: "InvalidAuthentication" });
});

test("URL and language helpers normalize common inputs", () => {
  assert.equal(resolveDashScopeUrl("https://dashscope.aliyuncs.com/api-ws/v1/inference/"), "wss://dashscope.aliyuncs.com/api-ws/v1/inference/");
  assert.equal(resolveDashScopeUrl(""), "wss://dashscope.aliyuncs.com/api-ws/v1/inference");
  assert.equal(normalizeDashScopeLanguage("zh"), "zh");
  assert.equal(normalizeDashScopeLanguage("zh-CN"), "zh");
  assert.equal(normalizeDashScopeLanguage("en-US"), "en");
  assert.equal(normalizeDashScopeLanguage("auto"), "");
  assert.equal(normalizeDashScopeLanguage("ja-JP"), "ja");
});

test("realtime session buffers PCM until task-started, then streams partial and final results", async () => {
  const socket = new FakeSocket();
  const statuses: string[] = [];
  const partials: string[] = [];
  const finals: Array<{ text: string; startMs?: number; endMs?: number }> = [];
  const errors: string[] = [];
  const session = new DashScopeRealtimeSession({
    url: "wss://dashscope.aliyuncs.com/api-ws/v1/inference/",
    apiKey: "test-key",
    model: "qwen-audio-3.1-asr-flash-streaming",
    language: "zh-CN",
    createTaskId: () => "task-1",
    connectTimeoutMs: 1000,
    heartbeatMs: 60000,
    createSocket: async () => socket,
    onStatus: (state) => statuses.push(state),
    onPartial: (text) => partials.push(text),
    onFinal: (result) => finals.push(result),
    onError: (message) => errors.push(message),
  });

  await session.start();
  assert.equal(socket.text.length, 1);
  assert.equal(JSON.parse(socket.text[0]).header.action, "run-task");

  session.push(new Uint8Array([1, 2, 3, 4]));
  assert.equal(socket.binary.length, 0);
  assert.equal(session.bufferedBytes, 4);

  socket.emit(startedEvent());
  assert.deepEqual(statuses, ["connecting", "listening"]);
  assert.equal(socket.binary.length, 1);
  assert.deepEqual([...socket.binary[0]], [1, 2, 3, 4]);

  socket.emit(resultEvent("你好", false));
  socket.emit(resultEvent("你好世界", true));
  assert.deepEqual(partials, ["你好", ""]);
  assert.deepEqual(finals, [{ text: "你好世界", startMs: 120, endMs: 900 }]);
  assert.deepEqual(errors, []);
  session.dispose();
});

test("realtime stop flushes pending audio and waits for task-finished", async () => {
  const socket = new FakeSocket();
  const statuses: string[] = [];
  const session = new DashScopeRealtimeSession({
    url: "wss://dashscope.aliyuncs.com/api-ws/v1/inference/",
    apiKey: "test-key",
    model: "m",
    language: "zh-CN",
    createTaskId: () => "task-1",
    stopFlushMs: 5000,
    heartbeatMs: 60000,
    createSocket: async () => socket,
    onStatus: (state) => statuses.push(state),
    onPartial: () => undefined,
    onFinal: () => undefined,
    onError: () => undefined,
  });

  await session.start();
  socket.emit(startedEvent());
  session.push(new Uint8Array([9, 8]));
  const stopping = session.stop();
  assert.equal(JSON.parse(socket.text.at(-1)!).header.action, "finish-task");
  assert.equal(socket.binary.length, 1);
  socket.emit(JSON.stringify({ header: { event: "task-finished", task_id: "task-1" }, payload: {} }));
  await stopping;
  assert.equal(statuses.at(-1), "done");
  assert.equal(socket.closed, true);
});

test("realtime session reports authentication failures", async () => {
  const socket = new FakeSocket();
  const errors: string[] = [];
  const statuses: string[] = [];
  const session = new DashScopeRealtimeSession({
    url: "wss://dashscope.aliyuncs.com/api-ws/v1/inference/",
    apiKey: "bad-key",
    model: "m",
    language: "zh-CN",
    createTaskId: () => "task-1",
    heartbeatMs: 60000,
    createSocket: async () => socket,
    onStatus: (state) => statuses.push(state),
    onPartial: () => undefined,
    onFinal: () => undefined,
    onError: (message) => errors.push(message),
  });

  await session.start();
  socket.emit(
    JSON.stringify({
      header: { event: "task-failed", error_code: "InvalidAuthentication", error_message: "Invalid API-key" },
      payload: {},
    }),
  );
  assert.equal(errors.length, 1);
  assert.match(errors[0], /鉴权失败/);
  assert.equal(statuses.at(-1), "error");
  session.dispose();
});

test("realtime session times out when the server never starts the task", async () => {
  const socket = new FakeSocket();
  const errors: string[] = [];
  const session = new DashScopeRealtimeSession({
    url: "wss://dashscope.aliyuncs.com/api-ws/v1/inference/",
    apiKey: "test-key",
    model: "m",
    language: "zh-CN",
    createTaskId: () => "task-1",
    connectTimeoutMs: 1000,
    heartbeatMs: 60000,
    createSocket: async () => socket,
    onStatus: () => undefined,
    onPartial: () => undefined,
    onFinal: () => undefined,
    onError: (message) => errors.push(message),
  });

  await session.start();
  await new Promise((resolve) => setTimeout(resolve, 1150));
  assert.equal(errors.length, 1);
  assert.match(errors[0], /未在限定时间内响应/);
  session.dispose();
});
