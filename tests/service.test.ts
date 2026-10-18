import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppService, type ServiceAdapters } from "../src/main/service.ts";
import { Logger } from "../src/main/logger.ts";
import type { SecretsStore } from "../src/main/secrets.ts";
import type { AppSettings, ScreenshotMeta, SecretKey } from "../src/shared/models.ts";
import {
  DASHSCOPE_ASR_LANGUAGE,
  DASHSCOPE_ASR_MODEL,
  DASHSCOPE_REALTIME_BASE_URL,
  defaultSettings,
} from "../src/shared/models.ts";
import { payloadSchemas } from "../src/shared/protocol.ts";
import { AppError } from "../src/shared/result.ts";

class FakeSecrets {
  encryption = false;
  private values = new Map<SecretKey, string>();

  async load(): Promise<void> {}

  status() {
    return {
      llm: this.values.has("llm"),
      transcription: this.values.has("transcription"),
      vision: this.values.has("vision"),
      extraction: this.values.has("extraction"),
      lock: false,
    };
  }

  get(key: SecretKey): string | null {
    return this.values.get(key) ?? null;
  }

  async set(key: SecretKey, value: string): Promise<void> {
    this.values.set(key, value);
  }

  async clear(key: SecretKey): Promise<void> {
    this.values.delete(key);
  }

  hasLock(): boolean {
    return false;
  }

  verifyLock(): boolean {
    return false;
  }

  async setLock(): Promise<void> {}

  async clearLock(): Promise<void> {}
}

type Harness = {
  service: AppService;
  dir: string;
  tick: () => number;
};

async function createHarness(
  t: test.TestContext,
  beforeInit?: (dir: string) => Promise<void>,
  adapters?: ServiceAdapters,
): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), "dh-service-"));
  let clock = 1_700_000_000_000;
  const secrets = new FakeSecrets();
  const service = new AppService({
    dataDir: dir,
    outDir: dir,
    appVersion: "0.1.0",
    logger: new Logger(dir),
    secrets: secrets as unknown as SecretsStore,
    adapters: { archiveDelayMs: () => 0, ...adapters },
    now: () => {
      clock += 10;
      return clock;
    },
  });
  if (beforeInit) await beforeInit(dir);
  await service.init();
  t.after(async () => {
    await service.shutdown();
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 40 });
  });
  return { service, dir, tick: () => clock };
}

async function bootServiceAt(dir: string): Promise<AppService> {
  const service = new AppService({
    dataDir: dir,
    outDir: dir,
    appVersion: "0.1.0",
    logger: new Logger(dir),
    secrets: new FakeSecrets() as unknown as SecretsStore,
    adapters: { archiveDelayMs: () => 0 },
  });
  await service.init();
  return service;
}

async function waitForMissing(path: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await readFile(path);
    } catch {
      return;
    }
    await delay(20);
  }
  throw new Error("file still exists: " + path);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor<T>(read: () => T, done: (value: T) => boolean, timeoutMs = 8000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let value = read();
  while (!done(value)) {
    if (Date.now() > deadline) throw new Error("waitFor timeout: " + JSON.stringify(value));
    await delay(25);
    value = read();
  }
  return value;
}

function answerById(service: AppService, id: string) {
  return service.currentSession().answers.find((answer) => answer.id === id);
}

type RealtimeOptions = Parameters<NonNullable<ServiceAdapters["createRealtimeSession"]>>[0];

function captureRealtimeSessions() {
  const options: RealtimeOptions[] = [];
  let pushedBytes = 0;
  return {
    options,
    adapter: (sessionOptions: RealtimeOptions) => {
      options.push(sessionOptions);
      return {
        get bufferedBytes() {
          return pushedBytes;
        },
        start: async () => {
          sessionOptions.onStatus("listening");
        },
        push: (pcm: Uint8Array) => {
          pushedBytes += pcm.byteLength;
        },
        stop: async () => {
          sessionOptions.onStatus("done");
        },
        dispose: () => undefined,
      };
    },
  };
}

async function useRealtime(service: AppService): Promise<void> {
  const next = structuredClone(service.settings) as AppSettings;
  next.transcription = {
    ...next.transcription,
    provider: "dashscope",
    mode: "realtime",
    baseUrl: DASHSCOPE_REALTIME_BASE_URL,
    model: DASHSCOPE_ASR_MODEL,
    language: DASHSCOPE_ASR_LANGUAGE,
  };
  await service.updateSettings(next);
  await service.setSecret("transcription", "test-key");
}

test("service boots with no account, auth, subscription, or entitlement state", async (t) => {
  const { service } = await createHarness(t);
  const snapshot = service.snapshot();
  assert.ok(snapshot.session.id.startsWith("sess_"));
  assert.equal(snapshot.lock.enabled, false);
  assert.equal(snapshot.lock.unlocked, true);
  assert.deepEqual(Object.keys(snapshot.secrets).sort(), ["extraction", "llm", "lock", "transcription", "vision"]);

  const serialized = JSON.stringify(snapshot).toLowerCase();
  for (const forbidden of ["account_id", "accountid", "auth_token", "accesstoken", "entitlement", "subscription"]) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
  for (const channel of Object.keys(payloadSchemas)) {
    assert.equal(channel.startsWith("auth."), false, channel);
  }
});

test("transcription maps each audio source to its configured speaker", async (t) => {
  const { service } = await createHarness(t);
  const next = JSON.parse(JSON.stringify(service.settings)) as AppSettings;
  next.transcription.provider = "mock";
  next.voice = { micSpeaker: "interviewer", systemSpeaker: "me" };
  await service.updateSettings(next);

  const mic = await service.transcribe({
    channel: "mic",
    mimeType: "audio/wav",
    data: new Uint8Array(44),
    startMs: 120,
    endMs: 900,
  });
  assert.equal(mic.segment?.speaker, "interviewer");
  assert.equal(mic.segment?.source, "mic");
  assert.equal(mic.segment?.startMs, 120);
  assert.equal(mic.segment?.endMs, 900);

  const system = await service.transcribe({
    channel: "system",
    mimeType: "audio/wav",
    data: new Uint8Array(44),
  });
  assert.equal(system.segment?.speaker, "me");
  assert.equal(system.segment?.source, "system");
});

test("dashscope realtime sessions stream PCM and append final segments", async (t) => {
  let options: Parameters<NonNullable<ServiceAdapters["createRealtimeSession"]>>[0] | null = null;
  let started = false;
  let stopped = false;
  let pushedBytes = 0;
  const { service } = await createHarness(t, undefined, {
    createRealtimeSession: (sessionOptions) => {
      options = sessionOptions;
      return {
        get bufferedBytes() {
          return pushedBytes;
        },
        start: async () => {
          started = true;
          sessionOptions.onStatus("connecting");
          sessionOptions.onStatus("listening");
        },
        push: (pcm) => {
          pushedBytes += pcm.byteLength;
        },
        stop: async () => {
          stopped = true;
          sessionOptions.onStatus("done");
        },
        dispose: () => undefined,
      };
    },
  });

  const next = JSON.parse(JSON.stringify(service.settings)) as AppSettings;
  next.transcription = {
    ...next.transcription,
    provider: "dashscope",
    mode: "realtime",
    baseUrl: DASHSCOPE_REALTIME_BASE_URL,
    model: DASHSCOPE_ASR_MODEL,
    language: DASHSCOPE_ASR_LANGUAGE,
  };
  await service.updateSettings(next);
  await service.setSecret("transcription", "test-key");

  assert.deepEqual(await service.startRealtime("mic"), { started: true, state: "listening" });
  assert.equal(started, true);
  assert.equal(options?.apiKey, "test-key");
  assert.equal(options?.model, DASHSCOPE_ASR_MODEL);
  assert.equal(options?.language, DASHSCOPE_ASR_LANGUAGE);

  assert.deepEqual(await service.pushRealtime({ channel: "mic", data: new Uint8Array([1, 2, 3, 4]) }), {
    accepted: true,
    buffered: 4,
  });
  assert.equal(pushedBytes, 4);

  options?.onFinal({ text: " 这是实时识别结果 ", startMs: 100, endMs: 900 });
  const segment = await waitFor(
    () => service.currentSession().segments.find((entry) => entry.text === "这是实时识别结果"),
    Boolean,
  );
  assert.equal(segment?.source, "mic");
  assert.equal(segment?.speaker, "me");
  assert.equal(segment?.startMs, 100);
  assert.equal(segment?.endMs, 900);

  assert.deepEqual(await service.stopRealtime("mic"), { stopped: true });
  assert.equal(stopped, true);
});

test("system transcript wins when its final arrives before the microphone echo", async (t) => {
  const capture = captureRealtimeSessions();
  const { service } = await createHarness(t, undefined, { createRealtimeSession: capture.adapter });
  await useRealtime(service);
  await service.startRealtime("mic");
  await service.startRealtime("system");
  const [mic, system] = capture.options;

  system.onFinal({ text: "请介绍一下你最近做过的项目", startMs: 0, endMs: 1800 });
  const systemSegment = await waitFor(
    () => service.currentSession().segments.find((segment) => segment.source === "system"),
    Boolean,
  );
  assert.equal(systemSegment?.speaker, "interviewer");

  mic.onFinal({ text: "请介绍一下你最近做过的项目。", startMs: 80, endMs: 1900 });
  await delay(80);
  assert.equal(service.currentSession().segments.length, 1);
  assert.equal(service.currentSession().segments[0].source, "system");
  assert.equal(service.currentSession().segments[0].speaker, "interviewer");

  await service.stopRealtime("mic");
  await service.stopRealtime("system");
});

test("a late system transcript replaces the microphone echo and keeps the other speaker", async (t) => {
  const capture = captureRealtimeSessions();
  const { service } = await createHarness(t, undefined, { createRealtimeSession: capture.adapter });
  await useRealtime(service);
  await service.startRealtime("mic");
  await service.startRealtime("system");
  const [mic, system] = capture.options;

  mic.onFinal({ text: "请介绍一下你最近做过的项目", startMs: 0, endMs: 1800 });
  const micSegment = await waitFor(
    () => service.currentSession().segments.find((segment) => segment.source === "mic"),
    Boolean,
  );
  assert.equal(micSegment?.speaker, "me");

  system.onFinal({ text: "请介绍下你最近做过的项目。", startMs: 120, endMs: 1920 });
  await waitFor(
    () => service.currentSession().segments.some((segment) => segment.source === "system"),
    Boolean,
  );
  const segments = service.currentSession().segments;
  assert.equal(segments.length, 1);
  assert.equal(segments[0].source, "system");
  assert.equal(segments[0].speaker, "interviewer");

  await service.stopRealtime("mic");
  await service.stopRealtime("system");
});

test("simultaneous but different microphone speech is kept", async (t) => {
  const capture = captureRealtimeSessions();
  const { service } = await createHarness(t, undefined, { createRealtimeSession: capture.adapter });
  await useRealtime(service);
  await service.startRealtime("mic");
  await service.startRealtime("system");
  const [mic, system] = capture.options;

  system.onFinal({ text: "请介绍一下你最近做过的项目", startMs: 0, endMs: 1800 });
  mic.onFinal({ text: "我最近在做支付系统和风控平台", startMs: 0, endMs: 2000 });
  await waitFor(() => service.currentSession().segments.length === 2, Boolean);

  const sources = service.currentSession().segments.map((segment) => segment.source).sort();
  assert.deepEqual(sources, ["mic", "system"]);
  assert.equal(
    service.currentSession().segments.find((segment) => segment.source === "mic")?.speaker,
    "me",
  );
  assert.equal(
    service.currentSession().segments.find((segment) => segment.source === "system")?.speaker,
    "interviewer",
  );

  await service.stopRealtime("mic");
  await service.stopRealtime("system");
});

test("three consecutive remote sentences keep the system speaker when microphone echoes interleave", async (t) => {
  const capture = captureRealtimeSessions();
  const { service } = await createHarness(t, undefined, { createRealtimeSession: capture.adapter });
  await useRealtime(service);
  await service.startRealtime("mic");
  await service.startRealtime("system");
  const [mic, system] = capture.options;
  const sentences = [
    { text: "请先介绍一下你最近做过的项目", startMs: 0, endMs: 1800 },
    { text: "这个项目里你主要负责哪一部分", startMs: 2600, endMs: 4400 },
    { text: "遇到过最难的问题是什么", startMs: 5200, endMs: 7000 },
  ];

  for (let index = 0; index < sentences.length; index += 1) {
    const sentence = sentences[index];
    if (index % 2 === 0) {
      system.onFinal(sentence);
      await waitFor(
        () => service.currentSession().segments.filter((segment) => segment.source === "system").length,
        (count) => count >= index + 1,
      );
      mic.onFinal({
        text: `${sentence.text}。`,
        startMs: sentence.startMs + 60,
        endMs: sentence.endMs + 120,
      });
    } else {
      mic.onFinal(sentence);
      await waitFor(
        () =>
          service
            .currentSession()
            .segments.some((segment) => segment.source === "mic" && segment.text === sentence.text),
        Boolean,
      );
      system.onFinal({
        text: `${sentence.text}。`,
        startMs: sentence.startMs + 50,
        endMs: sentence.endMs + 90,
      });
      await waitFor(
        () =>
          service
            .currentSession()
            .segments.some((segment) => segment.source === "system" && segment.text.includes(sentence.text)),
        Boolean,
      );
    }
    await delay(140);
  }

  const segments = service.currentSession().segments;
  assert.equal(segments.length, sentences.length);
  assert.deepEqual(
    segments.map((segment) => segment.source),
    ["system", "system", "system"],
  );
  assert.ok(segments.every((segment) => segment.speaker === "interviewer"));
  sentences.forEach((sentence, index) => {
    assert.ok(segments[index].text.includes(sentence.text));
  });

  await service.stopRealtime("mic");
  await service.stopRealtime("system");
});

test("auto answer streams to done using the local mock provider", async (t) => {
  const { service } = await createHarness(t);
  const result = await service.appendTranscript({
    speaker: "interviewer",
    text: "请介绍一下你最近做过的项目？",
    source: "system",
  });
  assert.equal(result.decision.action, "answer");
  const answerId = service.currentSession().inflightAnswerId;
  assert.ok(answerId);

  const answer = await waitFor(
    () => answerById(service, answerId as string),
    (value) => Boolean(value && value.status !== "streaming"),
  );
  assert.equal(answer?.status, "done");
  assert.ok((answer?.text.length ?? 0) > 20);
  assert.ok(answer?.text.includes("演示模式"));
  assert.equal(answer?.model, service.settings.llm.model);
  assert.equal(service.currentSession().inflightAnswerId, null);
});

test("starting a new session cancels and discards the old stream", async (t) => {
  const { service } = await createHarness(t);
  const oldSessionId = service.currentId;
  const started = await service.startAnswer("旧会话里正在生成的问题", "manual");
  assert.ok(started.answerId);
  await delay(30);

  await service.newSession();
  assert.notEqual(service.currentId, oldSessionId);
  assert.equal(service.currentSession().answers.length, 0);

  await delay(320);
  const oldSession = service.sessions.find((session) => session.id === oldSessionId);
  assert.ok(oldSession);
  const oldAnswer = oldSession?.answers.find((answer) => answer.id === started.answerId);
  assert.equal(oldAnswer?.status, "cancelled");
  assert.equal(oldSession?.inflightAnswerId, null);
});

test("cancel marks the answer cancelled and keeps it cancelled", async (t) => {
  const { service } = await createHarness(t);
  const started = await service.startAnswer("这个回答会被取消", "manual");
  await delay(40);

  const result = await service.cancelAnswer(started.answerId);
  assert.deepEqual(result, { cancelled: true });
  assert.equal(answerById(service, started.answerId)?.status, "cancelled");

  await delay(320);
  assert.equal(answerById(service, started.answerId)?.status, "cancelled");
  assert.equal(service.currentSession().inflightAnswerId, null);
});

test("queued questions are drained automatically after the first answer", async (t) => {
  const { service } = await createHarness(t);
  const first = await service.startAnswer("第一个问题", "manual");
  const second = await service.startAnswer("第二个问题", "manual");
  assert.equal(second.queued, true);
  assert.equal(service.currentSession().queue.length, 1);

  await waitFor(
    () => service.currentSession().answers,
    (answers) => answers.length === 2 && answers.every((answer) => answer.status === "done"),
  );
  assert.equal(service.currentSession().queue.length, 0);
  const answers = service.currentSession().answers;
  assert.equal(answers.length, 2);
  assert.equal(answers[0].id, first.answerId);
  assert.notEqual(answers[1].id, first.answerId);
  assert.equal(second.answerId, first.answerId);
});

test("cancelling the current answer drains the queued question", async (t) => {
  const { service } = await createHarness(t);
  const first = await service.startAnswer("第一个会被取消的问题", "manual");
  const second = await service.startAnswer("第二个排队问题", "manual");
  assert.equal(second.queued, true);
  assert.equal(service.currentSession().queue.length, 1);
  await delay(30);

  const cancelled = await service.cancelAnswer(first.answerId);
  assert.equal(cancelled.cancelled, true);
  assert.equal(service.currentSession().queue.length, 0);

  const answers = await waitFor(
    () => service.currentSession().answers,
    (items) =>
      items.length === 2 &&
      items.some((answer) => answer.id === first.answerId && answer.status === "cancelled") &&
      items.some((answer) => answer.id !== first.answerId && answer.status === "done"),
  );
  assert.equal(answers.length, 2);
});

test("a screenshot group starts while a voice answer is streaming", async (t) => {
  const { service, dir } = await createHarness(t);
  const settings = structuredClone(service.settings) as AppSettings;
  settings.screenshot.strategy = "vision";
  await service.updateSettings(settings);

  const voice = await service.startAnswer("语音长问题".repeat(240), "manual");
  assert.equal(service.currentSession().inflightAnswerId, voice.answerId);

  const meta = screenshotMeta({ id: "shot_parallel_voice", file: "shot_parallel_voice.png" });
  await addScreenshot(service, dir, meta);
  const started = await service.analyzeScreenshot(meta.id);

  assert.notEqual(started.answerId, voice.answerId);
  assert.equal(answerById(service, started.answerId)?.lane, "screenshot");
  assert.equal(service.currentSession().inflightScreenshotAnswerId, started.answerId);
  assert.equal(service.currentSession().inflightAnswerId, voice.answerId);

  await service.cancelAnswer(voice.answerId);
  await service.cancelAnswer(started.answerId);
});

test("a voice answer starts while a screenshot answer is streaming", async (t) => {
  const { service } = await createHarness(t);
  const shot = await service.startAnswer("截图长问题".repeat(240), "screenshot");
  assert.equal(service.currentSession().inflightScreenshotAnswerId, shot.answerId);
  assert.equal(service.currentSession().inflightAnswerId, null);

  const voice = await service.startAnswer("并发的语音问题", "manual");
  assert.equal(voice.queued, undefined);
  assert.equal(service.currentSession().queue.length, 0);
  assert.equal(service.currentSession().inflightAnswerId, voice.answerId);
  assert.equal(service.currentSession().inflightScreenshotAnswerId, shot.answerId);

  await service.cancelAnswer(shot.answerId);
  await service.cancelAnswer(voice.answerId);
});

test("cancelling one lane leaves the other answer running", async (t) => {
  const { service } = await createHarness(t);
  const voice = await service.startAnswer("不会连累截图的语音问题".repeat(160), "manual");
  const shot = await service.startAnswer("不会连累语音的截图问题".repeat(160), "screenshot");

  await service.cancelAnswer(voice.answerId);
  assert.equal(answerById(service, voice.answerId)?.status, "cancelled");
  assert.equal(answerById(service, shot.answerId)?.status, "streaming");
  assert.equal(service.currentSession().inflightAnswerId, null);
  assert.equal(service.currentSession().inflightScreenshotAnswerId, shot.answerId);

  await service.cancelAnswer(shot.answerId);
  assert.equal(answerById(service, shot.answerId)?.status, "cancelled");
  assert.equal(service.currentSession().inflightScreenshotAnswerId, null);
});

test("voice queue is not drained by screenshot completion", async (t) => {
  const { service } = await createHarness(t);
  const first = await service.startAnswer("第一条语音长问题".repeat(200), "manual");
  const second = await service.startAnswer("第二条语音问题", "manual");
  assert.equal(second.queued, true);
  assert.equal(service.currentSession().queue.length, 1);
  assert.equal(service.currentSession().queue[0].lane, "voice");

  const shot = await service.startAnswer("独立的截图长问题".repeat(200), "screenshot");
  assert.equal(shot.queued, undefined);
  assert.equal(service.currentSession().queue.length, 1);
  assert.equal(service.currentSession().inflightScreenshotAnswerId, shot.answerId);

  await service.cancelAnswer(shot.answerId);
  assert.equal(service.currentSession().queue.length, 1);
  assert.equal(service.currentSession().inflightAnswerId, first.answerId);

  await service.cancelAnswer(first.answerId);
  const drained = service.currentSession();
  assert.equal(drained.queue.length, 0);
  assert.ok(drained.inflightAnswerId);
  assert.notEqual(drained.inflightAnswerId, first.answerId);
  await service.cancelAnswer(drained.inflightAnswerId as string);
});

test("retry creates a fresh answer and leaves the original intact", async (t) => {
  const { service } = await createHarness(t);
  const started = await service.startAnswer("可以重试的问题", "manual");
  await waitFor(
    () => answerById(service, started.answerId),
    (answer) => answer?.status === "done",
  );

  const retried = await service.retryAnswer(started.answerId);
  assert.notEqual(retried.answerId, started.answerId);
  const original = answerById(service, started.answerId);
  assert.equal(original?.status, "done");

  const fresh = await waitFor(
    () => answerById(service, retried.answerId),
    (answer) => answer?.status === "done",
  );
  assert.ok((fresh?.text.length ?? 0) > 0);
  assert.equal(service.currentSession().answers.length, 2);
});

function screenshotMeta(overrides: Partial<ScreenshotMeta> = {}): ScreenshotMeta {
  return {
    id: "shot_test",
    createdAt: 1_700_000_000_000,
    mode: "full",
    width: 2,
    height: 2,
    file: "shot_test.png",
    displayId: "1",
    requestId: "req_1",
    screenshotContextId: "ctx_1",
    archiveRequestId: "arc_1",
    archiveState: "pending",
    archiveAttempts: 0,
    analysis: { status: "idle" },
    ...overrides,
  };
}

test("screenshot archive failure is non-blocking and guard mismatch is rejected", async (t) => {
  const { service, dir } = await createHarness(t);
  const meta = screenshotMeta();
  await mkdir(join(dir, "screenshots"), { recursive: true });
  await writeFile(join(dir, "screenshots", meta.file), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  service.screenshots.push(meta);

  const readBack = await service.readScreenshot(meta.id);
  assert.ok(readBack.dataUrl.startsWith("data:image/png;base64,"));

  const guard = {
    requestId: meta.requestId,
    screenshotContextId: meta.screenshotContextId,
    archiveRequestId: meta.archiveRequestId,
  };
  await assert.rejects(
    service.archiveWithRetry(meta.id, { ...guard, archiveRequestId: "arc_other" }),
    (error: unknown) => error instanceof AppError && error.code === "CONFLICT",
  );

  const previous = process.env.DH_ARCHIVE_FAIL;
  process.env.DH_ARCHIVE_FAIL = "1";
  try {
    const archived = await service.archiveWithRetry(meta.id, guard);
    assert.equal(archived.archiveState, "failed");
    assert.equal(archived.archiveAttempts, 3);
    assert.ok(archived.archiveError);
  } finally {
    if (previous === undefined) delete process.env.DH_ARCHIVE_FAIL;
    else process.env.DH_ARCHIVE_FAIL = previous;
  }

  const started = await service.startAnswer("归档失败后仍然可以回答", "manual");
  const answer = await waitFor(
    () => answerById(service, started.answerId),
    (value) => value?.status === "done",
  );
  assert.equal(answer?.status, "done");
});

test("a screenshot left streaming by a previous run is recovered as interrupted", async (t) => {
  const { service } = await createHarness(t, async (dir) => {
    await writeFile(
      join(dir, "screenshots.json"),
      JSON.stringify({
        version: 1,
        items: [
          {
            id: "shot_stale",
            createdAt: 1_700_000_000_000,
            mode: "region",
            width: 10,
            height: 10,
            file: "shot_stale.png",
            analysis: { status: "streaming", stage: "solving", route: "vision", startedAt: 1 },
          },
        ],
      }),
    );
  });
  const meta = service.screenshots.find((item) => item.id === "shot_stale");
  assert.equal(meta?.analysis.status, "error");
  assert.equal(meta?.analysis.stage, "error");
  assert.match(meta?.analysis.error ?? "", /中断/);
});

test("knowledge imports enforce the configured byte limit", async (t) => {
  const { service } = await createHarness(t);
  const settings = structuredClone(service.settings) as AppSettings;
  settings.kb.maxFileBytes = 1000;
  await service.updateSettings(settings);

  await assert.rejects(
    service.importKnowledgeText("too-big.txt", "x".repeat(2000)),
    (error: unknown) => error instanceof AppError && error.code === "LIMIT",
  );

  const imported = await service.importKnowledgeText(
    "notes.txt",
    "项目背景：这是一个本地优先的面试辅助工具。设计目标包括低延迟、可取消与数据不出本机。",
  );
  assert.equal(imported.imported, 1);
  assert.equal(imported.summary.docCount, 1);
  assert.ok(imported.summary.chunkCount >= 1);
  const updated = JSON.parse(await readFile(join(service.dataDir, "knowledge.json"), "utf8"));
  assert.equal(updated.docs.length, 1);
});

test("settings update forwards capture protection to the overlay bridge", async (t) => {
  const { service } = await createHarness(t);
  const applied: boolean[] = [];
  service.setOverlayBridge({
    apply: (settings) => applied.push(settings.privacy.excludeFromCapture),
    toggle: () => false,
    setClickThrough: () => undefined,
    setInteraction: () => undefined,
    drag: () => undefined,
    resize: () => undefined,
    openRegionSelector: async () => true,
    closeRegionSelector: () => true,
  });
  const settings = structuredClone(service.settings) as AppSettings;
  settings.privacy.excludeFromCapture = false;
  await service.updateSettings(settings);
  assert.equal(applied.at(-1), false);
});

test("overlay interaction, drag and resize stay usable while click-through is on", async (t) => {
  const { service } = await createHarness(t);
  const calls: string[] = [];
  service.setOverlayBridge({
    apply: () => undefined,
    toggle: () => false,
    setClickThrough: (value) => calls.push(`clickThrough:${value}`),
    setInteraction: (active) => calls.push(`interaction:${active}`),
    drag: (phase, dx, dy) => calls.push(`drag:${phase}:${dx ?? 0}:${dy ?? 0}`),
    resize: (size) => calls.push(`resize:${size.width}x${size.height}`),
    openRegionSelector: async () => true,
    closeRegionSelector: () => true,
  });

  assert.equal(service.settings.overlay.clickThrough, true);
  service.setOverlayInteraction(true);
  service.dragOverlay("start");
  service.dragOverlay("move", 120, -40);
  service.dragOverlay("end");
  assert.deepEqual(service.resizeOverlay({ width: 100, height: 5000 }), { width: 680, height: 4000 });

  assert.deepEqual(calls, [
    "interaction:true",
    "drag:start:0:0",
    "drag:move:120:-40",
    "drag:end:0:0",
    "resize:680x4000",
  ]);
  assert.equal(service.settings.overlay.clickThrough, true);
});

test("settings migration enforces auto answer and click-through defaults", async (t) => {
  const legacy = structuredClone(defaultSettings()) as AppSettings;
  legacy.version = 2;
  legacy.trigger.autoAnswer = false;
  legacy.overlay.clickThrough = false;
  legacy.overlay.compact = false;
  legacy.overlay.bounds = { x: 0, y: 0, width: 1086, height: 703 };
  const { service } = await createHarness(t, async (dir) => {
    await writeFile(join(dir, "settings.json"), JSON.stringify(legacy), "utf8");
  });

  assert.equal(service.settings.version, 5);
  assert.equal(service.settings.trigger.autoAnswer, true);
  assert.equal(service.settings.overlay.clickThrough, true);
  assert.equal(service.settings.overlay.compact, true);
  assert.equal(service.settings.overlay.bounds, null);
  assert.equal(service.settings.overlay.opacity, 0.86);

  await service.updateOverlay({ clickThrough: false });
  assert.equal(service.settings.overlay.clickThrough, true);
  assert.equal(service.settings.trigger.autoAnswer, true);
});

async function addScreenshot(service: AppService, dir: string, meta: ScreenshotMeta): Promise<void> {
  await mkdir(join(dir, "screenshots"), { recursive: true });
  await writeFile(join(dir, "screenshots", meta.file), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  service.screenshots.push(meta);
}

test("screenshot extract route records the extracted problem and solves it", async (t) => {
  const { service, dir } = await createHarness(t);
  const settings = structuredClone(service.settings) as AppSettings;
  settings.screenshot.strategy = "extract";
  await service.updateSettings(settings);

  const meta = screenshotMeta({ id: "shot_extract", file: "shot_extract.png" });
  await addScreenshot(service, dir, meta);

  const started = await service.analyzeScreenshot(meta.id);
  const answer = await waitFor(
    () => answerById(service, started.answerId),
    (value) => value?.status === "done",
  );
  assert.equal(answer?.status, "done");
  assert.equal(answer?.model, service.settings.llm.model);
  assert.equal(meta.analysis.stage, "done");
  assert.equal(meta.analysis.route, "extract");
  assert.ok(meta.analysis.extracted?.problemStatement.includes("演示模式"));
  assert.equal(meta.analysis.answerId, started.answerId);
  assert.ok((answer?.text.length ?? 0) > 20);
});

test("concurrent screenshot tasks are rejected instead of running twice", async (t) => {
  const { service, dir } = await createHarness(t);
  const settings = structuredClone(service.settings) as AppSettings;
  settings.screenshot.strategy = "extract";
  await service.updateSettings(settings);

  const first = screenshotMeta({ id: "shot_lock_a", file: "shot_lock_a.png" });
  const second = screenshotMeta({ id: "shot_lock_b", file: "shot_lock_b.png" });
  await addScreenshot(service, dir, first);
  await addScreenshot(service, dir, second);

  const pending = service.analyzeScreenshot(first.id);
  await assert.rejects(
    service.analyzeScreenshot(second.id),
    (error: unknown) => error instanceof AppError && error.code === "CONFLICT",
  );
  const started = await pending;
  const answer = await waitFor(
    () => answerById(service, started.answerId),
    (value) => value?.status === "done",
  );
  assert.equal(answer?.status, "done");
  assert.equal(first.analysis.stage, "done");

  const extracted = await service.extractScreenshot(second.id);
  assert.ok(extracted.extracted.problemStatement.length > 0);
});

test("vision failure falls back to extraction and text solving", async (t) => {
  const { service, dir } = await createHarness(t);
  const events: string[] = [];
  service.setEmitter((name) => events.push(name));
  const settings = structuredClone(service.settings) as AppSettings;
  settings.vision = {
    provider: "openai",
    baseUrl: "http://127.0.0.1:9/v1",
    model: "vision-test",
    maxTokens: 512,
  };
  settings.screenshot.fallbackToExtract = true;
  await service.updateSettings(settings);
  await service.setSecret("vision", "test-key");

  const meta = screenshotMeta({ id: "shot_fallback", file: "shot_fallback.png" });
  await addScreenshot(service, dir, meta);

  const started = await service.analyzeScreenshot(meta.id, undefined, "vision");
  const answer = await waitFor(
    () => answerById(service, started.answerId),
    (value) => value?.status === "done" || value?.status === "error",
  );
  assert.equal(answer?.status, "done");
  assert.equal(meta.analysis.stage, "done");
  assert.equal(meta.analysis.route, "extract");
  assert.ok(meta.analysis.extracted?.problemStatement.includes("演示模式"));
  assert.equal(meta.analysis.solutionModel, service.settings.llm.model);
  assert.ok(events.includes("answer.reset"), "fallback should clear the partial vision output");
});

test("vision and extraction can reuse the text model configuration", async (t) => {
  const { service, dir } = await createHarness(t);
  const settings = structuredClone(service.settings) as AppSettings;
  settings.vision = { ...settings.vision, provider: "openai", useLlm: true };
  settings.extraction = { ...settings.extraction, provider: "openai", useLlm: true };
  await service.updateSettings(settings);
  assert.equal(service.settings.vision.useLlm, true);

  const meta = screenshotMeta({ id: "shot_reuse", file: "shot_reuse.png" });
  await addScreenshot(service, dir, meta);
  const started = await service.analyzeScreenshot(meta.id, undefined, "vision");
  const answer = await waitFor(
    () => answerById(service, started.answerId),
    (value) => value?.status === "done",
  );
  assert.equal(answer?.status, "done");
  assert.equal(meta.analysis.route, "vision");

  const withoutReuse = structuredClone(service.settings) as AppSettings;
  withoutReuse.vision.useLlm = false;
  await service.updateSettings(withoutReuse);
  const other = screenshotMeta({ id: "shot_no_reuse", file: "shot_no_reuse.png" });
  await addScreenshot(service, dir, other);
  await assert.rejects(
    service.analyzeScreenshot(other.id, undefined, "vision"),
    (error: unknown) => error instanceof AppError && /视觉模型未配置/.test(error.message),
  );
});

test("continuation keeps the previous answer and shares the screenshot context", async (t) => {
  const { service, dir } = await createHarness(t);
  const settings = structuredClone(service.settings) as AppSettings;
  settings.screenshot.strategy = "extract";
  await service.updateSettings(settings);

  const first = screenshotMeta({ id: "shot_first", file: "shot_first.png", screenshotContextId: "ctx_same" });
  const second = screenshotMeta({ id: "shot_second", file: "shot_second.png", screenshotContextId: "ctx_other" });
  await addScreenshot(service, dir, first);
  await addScreenshot(service, dir, second);

  const initial = await service.analyzeScreenshot(first.id);
  const initialAnswer = await waitFor(
    () => answerById(service, initial.answerId),
    (value) => value?.status === "done",
  );
  assert.equal(initialAnswer?.status, "done");

  const continued = await service.continueScreenshot(second.id);
  const nextAnswer = await waitFor(
    () => answerById(service, continued.answerId),
    (value) => value?.status === "done",
  );
  assert.equal(nextAnswer?.status, "done");
  assert.equal(second.screenshotContextId, "ctx_same");
  assert.equal(second.analysis.continuationOfAnswerId, initial.answerId);
  assert.equal(second.analysis.stage, "done");
  assert.deepEqual(second.analysis.sourceScreenshotIds, [first.id, second.id]);
  assert.ok((nextAnswer?.text.length ?? 0) > 20);
});

test("continuous screenshots solve as one multi-image group, then the next shot starts a new group", async (t) => {
  const { service, dir } = await createHarness(t);
  const settings = structuredClone(service.settings) as AppSettings;
  settings.screenshot.strategy = "extract";
  await service.updateSettings(settings);

  const first = screenshotMeta({
    id: "shot_group_a",
    file: "shot_group_a.png",
    createdAt: 1_700_000_000_000,
  });
  const second = screenshotMeta({
    id: "shot_group_b",
    file: "shot_group_b.png",
    createdAt: 1_700_000_000_100,
  });
  await addScreenshot(service, dir, first);
  await addScreenshot(service, dir, second);

  const group = service.trackScreenshot(first);
  const sameGroup = service.trackScreenshot(second);
  assert.equal(sameGroup.id, group.id);
  assert.deepEqual(sameGroup.screenshotIds, [first.id, second.id]);

  const started = await service.solveGroup(group.id);
  const answer = await waitFor(
    () => answerById(service, started.answerId),
    (value) => value?.status === "done",
  );
  const solvedGroup = await waitFor(
    () => service.groups.find((entry) => entry.id === group.id),
    (value) => value?.status === "answered",
  );
  assert.equal(answer?.groupId, group.id);
  assert.deepEqual(answer?.screenshotIds, [first.id, second.id]);
  assert.equal(solvedGroup?.solvedShotCount, 2);
  assert.equal(solvedGroup?.answerIds.includes(started.answerId), true);

  const third = screenshotMeta({
    id: "shot_group_c",
    file: "shot_group_c.png",
    createdAt: 1_700_000_000_200,
  });
  await addScreenshot(service, dir, third);
  const nextGroup = service.trackScreenshot(third);
  assert.notEqual(nextGroup.id, group.id);
  assert.equal(nextGroup.seq, group.seq + 1);
  assert.deepEqual(nextGroup.screenshotIds, [third.id]);
});

test("a failed group can append another screenshot and retry with a different route", async (t) => {
  const { service, dir } = await createHarness(t);
  const failing = structuredClone(service.settings) as AppSettings;
  failing.screenshot.strategy = "vision";
  failing.screenshot.fallbackToExtract = false;
  failing.vision.provider = "openai";
  failing.vision.useLlm = false;
  await service.updateSettings(failing);

  const first = screenshotMeta({
    id: "shot_retry_a",
    file: "shot_retry_a.png",
    createdAt: 1_700_000_000_000,
  });
  await addScreenshot(service, dir, first);
  const group = service.trackScreenshot(first);

  await assert.rejects(
    service.solveGroup(group.id),
    (error: unknown) => error instanceof AppError && /视觉模型未配置/.test(error.message),
  );
  const failed = service.groups.find((entry) => entry.id === group.id);
  assert.equal(failed?.status, "error");
  assert.ok(failed?.lastError);

  const second = screenshotMeta({
    id: "shot_retry_b",
    file: "shot_retry_b.png",
    createdAt: 1_700_000_000_100,
  });
  await addScreenshot(service, dir, second);
  const resumed = service.trackScreenshot(second);
  assert.equal(resumed.id, group.id);
  assert.deepEqual(resumed.screenshotIds, [first.id, second.id]);
  assert.equal(resumed.status, "collecting");
  assert.equal(resumed.lastError, undefined);

  const fixed = structuredClone(service.settings) as AppSettings;
  fixed.screenshot.strategy = "extract";
  fixed.extraction.provider = "mock";
  await service.updateSettings(fixed);
  const started = await service.solveGroup(group.id);
  await waitFor(
    () => answerById(service, started.answerId),
    (value) => value?.status === "done",
  );
  const answered = service.groups.find((entry) => entry.id === group.id);
  assert.equal(answered?.status, "answered");
  assert.equal(answered?.solvedShotCount, 2);
});

test("stopping a running group releases it for a fresh solve", async (t) => {
  const held: Array<() => void> = [];
  const server = createServer((request, response) => {
    request.resume();
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "正在解答" } }] })}\n\n`);
    held.push(() => response.end("data: [DONE]\n\n"));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    for (const finish of held.splice(0)) finish();
    server.closeAllConnections?.();
    server.close();
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no server address");

  const { service, dir } = await createHarness(t);
  const streaming = structuredClone(service.settings) as AppSettings;
  streaming.screenshot.strategy = "extract";
  streaming.extraction.provider = "mock";
  streaming.llm.provider = "openai";
  streaming.llm.baseUrl = `http://127.0.0.1:${address.port}`;
  streaming.llm.model = "slow-test-model";
  await service.updateSettings(streaming);
  await service.setSecret("llm", "test-key");

  const meta = screenshotMeta({ id: "shot_stop_a", file: "shot_stop_a.png" });
  await addScreenshot(service, dir, meta);
  const group = service.trackScreenshot(meta);
  const started = await service.solveGroup(group.id);
  assert.ok(started.answerId);
  assert.equal(service.currentSession().inflightScreenshotAnswerId, started.answerId);
  assert.equal(service.groups.find((entry) => entry.id === group.id)?.status, "answering");

  const stopped = await service.stopGroup(group.id);
  assert.deepEqual(stopped, { cancelled: true });
  const cancelled = service.groups.find((entry) => entry.id === group.id);
  assert.equal(cancelled?.status, "collecting");
  assert.equal(cancelled?.lastError, undefined);
  assert.equal(service.currentSession().inflightScreenshotAnswerId, null);
  assert.equal(answerById(service, started.answerId)?.status, "cancelled");

  const resumed = structuredClone(service.settings) as AppSettings;
  resumed.llm.provider = "mock";
  await service.updateSettings(resumed);
  const again = await service.solveGroup(group.id);
  assert.ok(again.answerId);
  await waitFor(
    () => answerById(service, again.answerId),
    (answer) => answer?.status === "done",
  );
  assert.equal(service.groups.find((entry) => entry.id === group.id)?.status, "answered");
});

test("deleting a group removes its screenshots, answers, files and inflight pointer", async (t) => {
  const { service, dir } = await createHarness(t);
  const settings = structuredClone(service.settings) as AppSettings;
  settings.screenshot.strategy = "extract";
  await service.updateSettings(settings);

  const first = screenshotMeta({ id: "shot_del_a", file: "shot_del_a.png" });
  const second = screenshotMeta({ id: "shot_del_b", file: "shot_del_b.png" });
  await addScreenshot(service, dir, first);
  await addScreenshot(service, dir, second);
  const group = service.trackScreenshot(first);
  service.trackScreenshot(second);

  const started = await service.solveGroup(group.id);
  await waitFor(
    () => answerById(service, started.answerId),
    (value) => value?.status === "done",
  );
  const removed = await service.deleteGroup(group.id);
  assert.equal(removed.deleted, true);
  assert.equal(service.groups.some((entry) => entry.id === group.id), false);
  assert.equal(service.screenshots.some((entry) => entry.id === first.id || entry.id === second.id), false);
  assert.equal(service.currentSession().answers.some((entry) => entry.id === started.answerId), false);
  assert.equal(service.currentSession().inflightAnswerId, null);
  assert.equal(service.currentSession().inflightScreenshotAnswerId, null);
  await waitForMissing(join(dir, "screenshots", first.file));
  await waitForMissing(join(dir, "screenshots", second.file));
});

test("deleting one screenshot keeps the remaining shots and group", async (t) => {
  const { service, dir } = await createHarness(t);
  const first = screenshotMeta({ id: "shot_single_a", file: "shot_single_a.png" });
  const second = screenshotMeta({ id: "shot_single_b", file: "shot_single_b.png" });
  await addScreenshot(service, dir, first);
  await addScreenshot(service, dir, second);
  const group = service.trackScreenshot(first);
  service.trackScreenshot(second);

  assert.deepEqual(await service.deleteScreenshot(first.id), { deleted: true });
  assert.equal(service.screenshots.some((entry) => entry.id === first.id), false);
  assert.equal(service.screenshots.some((entry) => entry.id === second.id), true);
  assert.deepEqual(service.groups.find((entry) => entry.id === group.id)?.screenshotIds, [second.id]);
  await waitForMissing(join(dir, "screenshots", first.file));

  assert.deepEqual(await service.deleteScreenshot(second.id), { deleted: true });
  assert.equal(service.groups.some((entry) => entry.id === group.id), false);
  assert.equal(service.screenshots.some((entry) => entry.id === second.id), false);
  await waitForMissing(join(dir, "screenshots", second.file));
});

test("legacy mobile settings are stripped without resetting other settings", async (t) => {
  const { service, dir } = await createHarness(t, async (target) => {
    await writeFile(
      join(target, "settings.json"),
      JSON.stringify({
        version: 3,
        llm: { model: "kept-model" },
        mobile: { enabled: true, port: 4319, bindLan: true },
      }),
    );
  });

  assert.equal(service.settings.llm.model, "kept-model");
  assert.equal("mobile" in (service.settings as unknown as Record<string, unknown>), false);
  const persisted = JSON.parse(await readFile(join(dir, "settings.json"), "utf8")) as Record<string, unknown>;
  assert.equal("mobile" in persisted, false);
  assert.equal((persisted.llm as { model?: string }).model, "kept-model");
});

test("legacy version-1 screenshots migrate into one group per screenshot context", async (t) => {
  const { service } = await createHarness(t, async (dir) => {
    await writeFile(
      join(dir, "screenshots.json"),
      JSON.stringify({
        version: 1,
        items: [
          {
            id: "shot_legacy_a",
            createdAt: 1_700_000_000_000,
            mode: "region",
            width: 10,
            height: 10,
            file: "shot_legacy_a.png",
            screenshotContextId: "ctx_legacy",
            analysis: { status: "idle" },
          },
          {
            id: "shot_legacy_b",
            createdAt: 1_700_000_001_000,
            mode: "region",
            width: 10,
            height: 10,
            file: "shot_legacy_b.png",
            screenshotContextId: "ctx_legacy",
            analysis: { status: "idle" },
          },
        ],
      }),
    );
  });

  const groups = service.snapshot().groups;
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].screenshotIds, ["shot_legacy_a", "shot_legacy_b"]);
  assert.equal(groups[0].status, "closed");
  assert.equal(groups[0].answerId, null);
});

test("group linkage on answers survives a service restart", async (t) => {
  const { service, dir } = await createHarness(t);
  const settings = structuredClone(service.settings) as AppSettings;
  settings.screenshot.strategy = "extract";
  await service.updateSettings(settings);

  const first = screenshotMeta({ id: "shot_persist_a", file: "shot_persist_a.png" });
  const second = screenshotMeta({ id: "shot_persist_b", file: "shot_persist_b.png" });
  await addScreenshot(service, dir, first);
  await addScreenshot(service, dir, second);
  const group = service.trackScreenshot(first);
  service.trackScreenshot(second);
  const started = await service.solveGroup(group.id);
  await waitFor(
    () => answerById(service, started.answerId),
    (value) => value?.status === "done",
  );

  const persisted = JSON.parse(await readFile(join(dir, "sessions.json"), "utf8"));
  const persistedAnswer = persisted.sessions
    .flatMap((session: { answers: Array<{ id: string; groupId?: string; screenshotIds?: string[] }> }) => session.answers)
    .find((answer: { id: string }) => answer.id === started.answerId);
  assert.equal(persistedAnswer?.groupId, group.id);
  assert.deepEqual(persistedAnswer?.screenshotIds, [first.id, second.id]);

  await service.shutdown();
  const reopened = await bootServiceAt(dir);
  try {
    const answer = reopened.currentSession().answers.find((entry) => entry.id === started.answerId);
    assert.equal(answer?.groupId, group.id);
    assert.deepEqual(answer?.screenshotIds, [first.id, second.id]);
  } finally {
    await reopened.shutdown();
  }
});

test("service transcribes through the DashScope HTTP provider", async (t) => {
  let authorization = "";
  const server = createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk: Buffer) => {
      raw += chunk.toString("utf8");
    });
    request.on("end", () => {
      authorization = String(request.headers.authorization ?? "");
      const body = JSON.parse(raw) as { model?: string };
      assert.equal(body.model, "qwen-audio-3.1-asr-flash");
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ output: { text: "这是百炼识别结果" } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections?.();
    server.close();
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no server address");

  const { service } = await createHarness(t);
  const settings = structuredClone(service.settings) as AppSettings;
  settings.transcription.provider = "dashscope-http";
  settings.transcription.baseUrl = `http://127.0.0.1:${address.port}`;
  settings.transcription.model = "qwen-audio-3.1-asr-flash";
  settings.transcription.mode = "batch";
  await service.updateSettings(settings);
  await service.setSecret("transcription", "test-key");

  const result = await service.transcribe({
    channel: "mic",
    mimeType: "audio/wav",
    data: new Uint8Array(44),
    startMs: 0,
    endMs: 800,
  });

  assert.equal(result.text, "这是百炼识别结果");
  assert.equal(result.segment?.text, "这是百炼识别结果");
  assert.equal(result.segment?.speaker, "me");
  assert.equal(authorization, "Bearer test-key");
});
