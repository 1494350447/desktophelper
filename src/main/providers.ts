import type {
  ExtractionSettings,
  LlmSettings,
  ProviderKind,
  ProviderSettings,
  TranscriptionSettings,
  VisionSettings,
} from "../shared/models.ts";
import { AppError } from "../shared/result.ts";
import { truncate } from "../shared/text.ts";
import type { ChatMessage } from "../shared/prompt.ts";
import { probeDashScopeRealtime } from "./dashscope.ts";
import { probeBailianTranscription, transcribeWithBailian } from "./bailian.ts";

export type ChatContent = string | Array<Record<string, unknown>>;
export type ChatMessageLike = { role: "system" | "user" | "assistant"; content: ChatContent };

export type StreamOptions = {
  temperature?: number;
  maxTokens?: number;
  signal: AbortSignal;
};

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, "")}${path}`;
}

function abortError(): Error {
  const error = new Error("aborted");
  error.name = "AbortError";
  return error;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(abortError());
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function extractQuestion(messages: ChatMessageLike[]): string {
  const user = [...messages].reverse().find((message) => message.role === "user");
  if (!user || typeof user.content !== "string") return "当前问题";
  const match = user.content.match(/\[问题\]\s*([\s\S]*)$/);
  const question = (match ? match[1] : user.content).trim();
  return truncate(question, 80) || "当前问题";
}

function hasImage(messages: ChatMessageLike[]): boolean {
  return messages.some((message) => Array.isArray(message.content));
}

function mockAnswer(messages: ChatMessageLike[]): string {
  if (hasImage(messages)) {
    return [
      "（演示模式，未调用视觉模型）",
      "",
      "已收到截图，但当前没有配置视觉模型，因此无法识别图片内容。",
      "",
      "在「设置 → 视觉」中填写 OpenAI 兼容接口、模型名和 API Key 后，这里会返回真实的识题与解答。",
    ].join("\n");
  }
  const question = extractQuestion(messages);
  return [
    "（演示模式，未调用真实模型）",
    "",
    `针对「${question}」，可以这样回答：`,
    "",
    "1. 先确认目标、输入与约束，避免答非所问。",
    "2. 给出一个可执行方案，并说明关键取舍。",
    "3. 用一个具体例子收尾，证明方案可落地。",
    "",
    "在「设置 → 模型」中把提供方切换为 OpenAI 兼容接口并填写 API Key，即可获得真实流式回答。",
  ].join("\n");
}

async function streamMock(
  messages: ChatMessageLike[],
  signal: AbortSignal,
  onDelta: (delta: string) => void,
): Promise<void> {
  const text = mockAnswer(messages);
  const chunkSize = 12;
  const configuredDelay = Number(process.env.DH_E2E_MOCK_DELAY_MS);
  const chunkDelay =
    process.env.DH_E2E === "1" && Number.isFinite(configuredDelay) && configuredDelay > 0 ? configuredDelay : 16;
  for (let index = 0; index < text.length; index += chunkSize) {
    if (signal.aborted) throw abortError();
    onDelta(text.slice(index, index + chunkSize));
    await sleep(chunkDelay, signal);
  }
}

function extractDelta(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  const choices = (payload as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return "";
  const choice = choices[0] as Record<string, unknown>;
  const delta = choice.delta as Record<string, unknown> | undefined;
  if (delta && typeof delta.content === "string") return delta.content;
  const message = choice.message as Record<string, unknown> | undefined;
  if (message && typeof message.content === "string") return message.content;
  if (typeof choice.text === "string") return choice.text;
  return "";
}

async function readError(response: Response): Promise<string> {
  try {
    const text = await response.text();
    return truncate(text.replace(/\s+/g, " ").trim(), 300);
  } catch {
    return "";
  }
}

type ChatStreamOutcome = {
  emittedChars: number;
  finishReason: string | null;
};

function readFinishReason(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const choices = (payload as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const choice = choices[0] as Record<string, unknown>;
  return typeof choice.finish_reason === "string" && choice.finish_reason ? choice.finish_reason : null;
}

function reasoningTokenFloor(settings: ProviderSettings): number {
  const model = settings.model.toLowerCase();
  const reasoning =
    /deepseek-(flash|reasoner|v4)/.test(model) ||
    /(^|[-_/])o[134]($|[-_/])/.test(model) ||
    model.includes("gpt-5") ||
    settings.baseUrl.toLowerCase().includes("deepseek.com");
  return reasoning ? 4096 : 0;
}

async function runChatStream(
  settings: ProviderSettings,
  apiKey: string,
  messages: ChatMessageLike[],
  options: StreamOptions,
  onDelta: (delta: string) => void,
  maxTokens: number,
): Promise<ChatStreamOutcome> {
  const response = await fetch(joinUrl(settings.baseUrl, "/chat/completions"), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: settings.model,
      messages,
      stream: true,
      ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
      max_tokens: maxTokens,
    }),
    signal: options.signal,
  }).catch((error: unknown) => {
    if ((error as Error).name === "AbortError") throw error;
    throw new AppError("NETWORK", `无法连接模型服务：${(error as Error).message}`);
  });

  if (!response.ok) {
    const detail = await readError(response);
    throw new AppError("PROVIDER_ERROR", `模型服务返回 ${response.status}${detail ? `：${detail}` : ""}`);
  }

  let emittedChars = 0;
  let finishReason: string | null = null;
  const consume = (payload: unknown): void => {
    finishReason = readFinishReason(payload) ?? finishReason;
    const text = extractDelta(payload);
    if (!text) return;
    emittedChars += text.trim().length;
    onDelta(text);
  };

  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("text/event-stream")) {
    const payload: unknown = await response.json();
    consume(payload);
    return { emittedChars, finishReason };
  }

  if (!response.body) throw new AppError("PROVIDER_ERROR", "模型服务未返回响应体");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let done = false;
  while (!done) {
    const chunk = await reader.read();
    if (chunk.done) break;
    buffer += decoder.decode(chunk.value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const data = trimmed.slice(5).trim();
      if (data === "[DONE]") {
        done = true;
        break;
      }
      if (!data) continue;
      try {
        consume(JSON.parse(data));
      } catch {
        // ignore malformed keep-alive frames
      }
    }
  }
  if (buffer.trim().startsWith("data:")) {
    const data = buffer.trim().slice(5).trim();
    if (data && data !== "[DONE]") {
      try {
        consume(JSON.parse(data));
      } catch {
        // ignore
      }
    }
  }
  return { emittedChars, finishReason };
}

export async function streamChat(
  settings: ProviderSettings,
  apiKey: string | null,
  messages: ChatMessageLike[],
  options: StreamOptions,
  onDelta: (delta: string) => void,
): Promise<void> {
  if (settings.provider === "mock") {
    await streamMock(messages, options.signal, onDelta);
    return;
  }
  if (!apiKey) {
    throw new AppError("UNAUTHORIZED", `${settings.provider === "openai" ? "模型" : settings.provider} API Key 未配置`);
  }
  const requested = Math.max(128, Math.floor(options.maxTokens ?? 900), reasoningTokenFloor(settings));
  const first = await runChatStream(settings, apiKey, messages, options, onDelta, requested);
  if (first.emittedChars > 0) return;
  if (first.finishReason === "length") {
    const retryTokens = Math.min(8192, Math.max(4096, requested * 2));
    if (retryTokens > requested && !options.signal.aborted) {
      const retry = await runChatStream(settings, apiKey, messages, options, onDelta, retryTokens);
      if (retry.emittedChars > 0) return;
      throw new AppError(
        "PROVIDER_ERROR",
        `模型在推理阶段耗尽了输出上限（已自动提升到 ${retryTokens} tokens），仍未返回最终答案。请提高最大 Token，或改用非推理模型。`,
      );
    }
    throw new AppError(
      "PROVIDER_ERROR",
      `模型输出被 max_tokens=${requested} 截断，未返回最终答案。请提高最大 Token，或改用非推理模型。`,
    );
  }
  throw new AppError("PROVIDER_ERROR", "模型返回了空内容，请检查模型名称与接口是否兼容");
}

export type TranscriptionSettingsLike = TranscriptionSettings;

export async function transcribeAudio(
  settings: TranscriptionSettings,
  apiKey: string | null,
  audio: Buffer,
  mimeType: string,
  signal: AbortSignal,
): Promise<string> {
  if (settings.provider === "mock") {
    await sleep(30, signal);
    return "（演示转写）这是一条本地演示消息，配置转写模型后会显示真实识别结果。";
  }
  if (settings.provider === "dashscope") {
    throw new AppError("UNSUPPORTED", "DashScope 实时转写请在设置中开启收音后直接说话");
  }
  if (settings.provider === "dashscope-http") {
    return transcribeWithBailian({
      endpoint: settings.baseUrl,
      apiKey: apiKey ?? "",
      model: settings.model,
      audio,
      mimeType,
      signal,
    });
  }
  if (!apiKey) throw new AppError("UNAUTHORIZED", "转写 API Key 未配置");
  if (audio.byteLength > 25 * 1024 * 1024) {
    throw new AppError("LIMIT", "单个音频片段超过 25MB，请缩短片段时长");
  }
  const form = new FormData();
  const normalized = mimeType.toLowerCase();
  const extension = normalized.includes("wav")
    ? "wav"
    : normalized.includes("ogg")
      ? "ogg"
      : normalized.includes("mp4") || normalized.includes("m4a")
        ? "m4a"
        : normalized.includes("mpeg")
          ? "mp3"
          : "webm";
  form.append("file", new Blob([audio], { type: mimeType }), `chunk.${extension}`);
  form.append("model", settings.model);
  if (settings.language) form.append("language", settings.language);
  form.append("response_format", "json");

  const response = await fetch(joinUrl(settings.baseUrl, "/audio/transcriptions"), {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}` },
    body: form,
    signal,
  }).catch((error: unknown) => {
    if ((error as Error).name === "AbortError") throw error;
    throw new AppError("NETWORK", `无法连接转写服务：${(error as Error).message}`);
  });
  if (!response.ok) {
    const detail = await readError(response);
    throw new AppError("PROVIDER_ERROR", `转写服务返回 ${response.status}${detail ? `：${detail}` : ""}`);
  }
  const payload = (await response.json()) as { text?: unknown };
  if (typeof payload.text !== "string") throw new AppError("PROVIDER_ERROR", "转写服务返回格式不正确");
  return payload.text.trim();
}

export async function analyzeImageStream(
  settings: VisionSettings,
  apiKey: string | null,
  imageDataUrl: string,
  prompt: string,
  options: StreamOptions,
  onDelta: (delta: string) => void,
): Promise<void> {
  await analyzeImagesStream(settings, apiKey, [imageDataUrl], prompt, options, onDelta);
}

export async function analyzeImagesStream(
  settings: VisionSettings | ExtractionSettings,
  apiKey: string | null,
  imageDataUrls: string[],
  prompt: string,
  options: StreamOptions,
  onDelta: (delta: string) => void,
): Promise<void> {
  if (imageDataUrls.length === 0) throw new AppError("VALIDATION", "没有可发送的截图");
  const content: Array<Record<string, unknown>> = [{ type: "text", text: prompt }];
  for (const image of imageDataUrls) {
    content.push({ type: "image_url", image_url: { url: image } });
  }
  await streamChat(
    settings,
    apiKey,
    [{ role: "user", content }],
    options,
    onDelta,
  );
}

function extractMessageText(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  const choices = (payload as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return "";
  const choice = choices[0] as Record<string, unknown>;
  const message = choice.message as Record<string, unknown> | undefined;
  if (!message) return "";
  if (typeof message.content === "string") return message.content;
  if (Array.isArray(message.content)) {
    return message.content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string") {
          return (part as { text: string }).text;
        }
        return "";
      })
      .join("");
  }
  return "";
}

export async function extractProblemFromImages(
  settings: ExtractionSettings,
  apiKey: string | null,
  imageDataUrls: string[],
  prompt: string,
  signal: AbortSignal,
): Promise<string> {
  if (imageDataUrls.length === 0) throw new AppError("VALIDATION", "没有可提取的截图");
  if (settings.provider === "mock") {
    await sleep(30, signal);
    return JSON.stringify({
      problem_statement: "（演示模式）已收到截图。配置提取模型后，这里会返回从图片识别的完整题面。",
      additional_context: "当前使用本地演示提取结果，不会调用真实模型。",
    });
  }
  if (!apiKey) throw new AppError("UNAUTHORIZED", "提取模型 API Key 未配置");
  const content: Array<Record<string, unknown>> = [{ type: "text", text: prompt }];
  for (const image of imageDataUrls) {
    content.push({ type: "image_url", image_url: { url: image } });
  }
  const attempt = async (maxTokens: number): Promise<{ text: string; finishReason: string | null }> => {
    const response = await fetch(joinUrl(settings.baseUrl, "/chat/completions"), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: settings.model,
        messages: [{ role: "user", content }],
        stream: false,
        temperature: 0,
        max_tokens: maxTokens,
      }),
      signal,
    }).catch((error: unknown) => {
      if ((error as Error).name === "AbortError") throw error;
      throw new AppError("NETWORK", `无法连接提取服务：${(error as Error).message}`);
    });
    if (!response.ok) {
      const detail = await readError(response);
      throw new AppError("PROVIDER_ERROR", `提取服务返回 ${response.status}${detail ? `：${detail}` : ""}`);
    }
    const payload: unknown = await response.json();
    return { text: extractMessageText(payload).trim(), finishReason: readFinishReason(payload) };
  };

  const firstMax = Math.max(settings.maxTokens, reasoningTokenFloor(settings));
  const first = await attempt(firstMax);
  if (first.text && first.finishReason !== "length") return first.text;
  if (first.finishReason === "length") {
    const retryMax = Math.min(8192, Math.max(4096, firstMax * 2));
    if (retryMax > firstMax && !signal.aborted) {
      const retry = await attempt(retryMax);
      if (retry.text && retry.finishReason !== "length") return retry.text;
      throw new AppError(
        "PROVIDER_ERROR",
        `提取模型在推理阶段耗尽了输出上限（已尝试 ${retryMax} tokens），请提高最大 Token 或改用非推理模型。`,
      );
    }
    throw new AppError(
      "PROVIDER_ERROR",
      `提取模型输出被 max_tokens=${firstMax} 截断，请提高最大 Token。`,
    );
  }
  throw new AppError("PROVIDER_ERROR", "提取服务返回了空内容");
}

export type ProviderTestResult = {
  ok: boolean;
  message: string;
  latencyMs?: number;
};

const PROBE_IMAGE =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

export async function testProvider(
  service: "llm" | "transcription" | "vision" | "extraction",
  settings: ProviderSettings,
  apiKey: string | null,
): Promise<ProviderTestResult> {
  if (settings.provider === "mock") {
    return { ok: true, message: "演示模式可用（不会访问网络）", latencyMs: 0 };
  }
  if (!apiKey) return { ok: false, message: "API Key 未配置" };
  if (service === "transcription" && settings.provider === "dashscope") {
    const transcription = settings as TranscriptionSettings;
    return probeDashScopeRealtime({
      url: transcription.baseUrl,
      apiKey,
      model: transcription.model,
      language: transcription.language,
    });
  }
  if (service === "transcription" && settings.provider === "dashscope-http") {
    const transcription = settings as TranscriptionSettings;
    return probeBailianTranscription({
      endpoint: transcription.baseUrl,
      apiKey,
      model: transcription.model,
    });
  }
  const started = Date.now();
  try {
    let response: Response;
    if (service === "llm") {
      response = await fetch(joinUrl(settings.baseUrl, "/chat/completions"), {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: settings.model,
          messages: [{ role: "user", content: "ping" }],
          max_tokens: 1,
          stream: false,
        }),
        signal: AbortSignal.timeout(15000),
      });
    } else if (service === "vision" || service === "extraction") {
      response = await fetch(joinUrl(settings.baseUrl, "/chat/completions"), {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: settings.model,
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: "Reply with OK." },
                { type: "image_url", image_url: { url: PROBE_IMAGE } },
              ],
            },
          ],
          max_tokens: 1,
          stream: false,
        }),
        signal: AbortSignal.timeout(20000),
      });
    } else {
      response = await fetch(joinUrl(settings.baseUrl, "/models"), {
        headers: { authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(15000),
      });
    }
    const latencyMs = Date.now() - started;
    if (response.status === 401 || response.status === 403) {
      return { ok: false, message: "API Key 被服务拒绝", latencyMs };
    }
    if (response.status === 404 && service === "transcription") {
      return { ok: true, message: "服务可达（该接口未提供 /models，未能完整校验）", latencyMs };
    }
    if (!response.ok) {
      const detail = await readError(response);
      return { ok: false, message: `服务返回 ${response.status}${detail ? `：${detail}` : ""}`, latencyMs };
    }
    return {
      ok: true,
      message: service === "vision" || service === "extraction" ? "连接成功（模型接受图片输入）" : "连接成功",
      latencyMs,
    };
  } catch (error) {
    return {
      ok: false,
      message: `连接失败：${(error as Error).message}`,
      latencyMs: Date.now() - started,
    };
  }
}

export function providerLabel(kind: ProviderKind): string {
  if (kind === "mock") return "演示模式";
  if (kind === "dashscope") return "DashScope 实时";
  if (kind === "dashscope-http") return "阿里百炼（HTTP 批量）";
  return "OpenAI 兼容";
}

export function asChatMessage(message: ChatMessage): ChatMessageLike {
  return { role: message.role, content: message.content };
}

export function llmMaxTokens(settings: LlmSettings): number {
  return settings.maxTokens;
}
