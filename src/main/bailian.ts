import {
  DASHSCOPE_HTTP_ENDPOINT,
  DASHSCOPE_HTTP_MODEL,
  DASHSCOPE_HTTP_SAMPLE_RATE,
} from "../shared/models.ts";
import { AppError } from "../shared/result.ts";
import { pcm16ToWav } from "../shared/audio.ts";
import type { ProviderTestResult } from "./providers.ts";

export const BAILIAN_MAX_AUDIO_BYTES = 10 * 1024 * 1024;
const GENERATION_PATH = "/services/aigc/multimodal-generation/generation";

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

function truncateDetail(text: string, max = 300): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max)}...` : clean;
}

export function normalizeBailianEndpoint(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return DASHSCOPE_HTTP_ENDPOINT;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new AppError("VALIDATION", "百炼接口地址不是有效的 URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new AppError("VALIDATION", "百炼接口地址必须是 http(s) URL");
  }

  let path = url.pathname.replace(/\/+$/, "");
  if (!path) path = "/api/v1";
  if (/\/generation$/i.test(path) && /multimodal-generation/i.test(path)) {
    // Already the complete generation endpoint.
  } else if (/\/multimodal-generation$/i.test(path)) {
    path += "/generation";
  } else if (/\/services\/aigc$/i.test(path)) {
    path += "/multimodal-generation/generation";
  } else if (/\/api\/v1$/i.test(path)) {
    path += GENERATION_PATH;
  } else {
    path += GENERATION_PATH;
  }

  url.pathname = path;
  url.search = "";
  url.hash = "";
  return url.toString();
}

export type BailianRequestOptions = {
  model: string;
  audio: Buffer;
  mimeType?: string;
};

export function buildBailianPayload(options: BailianRequestOptions): Record<string, unknown> {
  const mimeType = (options.mimeType ?? "audio/wav").trim() || "audio/wav";
  const dataUrl = `data:${mimeType};base64,${options.audio.toString("base64")}`;
  return {
    model: options.model.trim() || DASHSCOPE_HTTP_MODEL,
    input: {
      messages: [
        {
          role: "user",
          content: [
            {
              type: "input_audio",
              input_audio: { data: dataUrl },
            },
          ],
        },
      ],
    },
    parameters: {
      format: "wav",
      sample_rate: String(DASHSCOPE_HTTP_SAMPLE_RATE),
    },
  };
}

export function parseBailianTranscription(payload: unknown): string {
  const root = asRecord(payload);
  if (!root) return "";
  const output = asRecord(root.output);
  if (!output) return firstText(root.text);

  const direct = firstText(output.text);
  if (direct) return direct;

  const sentence = asRecord(output.sentence);
  if (sentence) {
    const text = firstText(sentence.text);
    if (text) return text;
  }

  if (Array.isArray(output.sentences)) {
    const parts: string[] = [];
    for (const entry of output.sentences) {
      const record = asRecord(entry);
      const text = firstText(record?.text);
      if (text) parts.push(text);
    }
    if (parts.length > 0) return parts.join("");
  }

  return "";
}

function readErrorBody(payload: unknown): { code: string; message: string; requestId: string } {
  const root = asRecord(payload);
  if (!root) return { code: "", message: "", requestId: "" };
  const nested = asRecord(root.error) ?? asRecord(root.output);
  const code = firstText(root.code, nested?.code);
  const message = firstText(root.message, nested?.message, root.msg);
  const requestId = firstText(root.request_id, root.requestId, nested?.request_id, nested?.requestId);
  return { code, message, requestId };
}

export function describeBailianHttpError(status: number, payload: unknown): AppError {
  const { code, message, requestId } = readErrorBody(payload);
  const detail = truncateDetail([code, message].filter(Boolean).join(": "));
  const suffix = detail ? `：${detail}` : requestId ? `（request_id: ${requestId}）` : "";
  if (status === 401 || status === 403) {
    return new AppError("UNAUTHORIZED", "百炼鉴权失败，请检查转写 API Key", { status, code, requestId });
  }
  if (status === 429) {
    return new AppError("LIMIT", `百炼请求过于频繁或配额不足${suffix}`, { status, code, requestId });
  }
  if (status === 400 || status === 404) {
    return new AppError("PROVIDER_ERROR", `百炼模型或参数不可用（HTTP ${status}）${suffix}`, {
      status,
      code,
      requestId,
    });
  }
  return new AppError("PROVIDER_ERROR", `百炼转写服务返回 HTTP ${status}${suffix}`, {
    status,
    code,
    requestId,
  });
}

export type BailianTranscribeOptions = {
  endpoint: string;
  apiKey: string;
  model: string;
  audio: Buffer;
  mimeType?: string;
  signal?: AbortSignal;
};

export async function transcribeWithBailian(options: BailianTranscribeOptions): Promise<string> {
  if (!options.apiKey) throw new AppError("UNAUTHORIZED", "转写 API Key 未配置");
  if (options.audio.byteLength === 0) throw new AppError("VALIDATION", "音频片段为空");
  if (options.audio.byteLength > BAILIAN_MAX_AUDIO_BYTES) {
    throw new AppError("LIMIT", "单个音频片段超过百炼 Base64 上传上限（约 10MB），请缩短片段时长");
  }

  const endpoint = normalizeBailianEndpoint(options.endpoint);
  const body = buildBailianPayload({
    model: options.model,
    audio: options.audio,
    mimeType: options.mimeType,
  });

  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${options.apiKey}`,
        "Content-Type": "application/json",
        "X-DashScope-SSE": "disable",
        "User-Agent": "Desktophelper/0.1",
      },
      body: JSON.stringify(body),
      signal: options.signal,
    });
  } catch (error) {
    if ((error as Error).name === "AbortError") throw error;
    throw new AppError("NETWORK", `无法连接百炼转写服务：${(error as Error).message}`);
  }

  if (!response.ok) {
    let payload: unknown = null;
    try {
      payload = await response.json();
    } catch {
      try {
        payload = { message: truncateDetail(await response.text()) };
      } catch {
        payload = null;
      }
    }
    throw describeBailianHttpError(response.status, payload);
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new AppError("PROVIDER_ERROR", "百炼转写服务返回了非 JSON 响应");
  }
  return parseBailianTranscription(payload);
}

function silenceWav(ms = 1000): Buffer {
  const samples = Math.max(1, Math.round((DASHSCOPE_HTTP_SAMPLE_RATE * ms) / 1000));
  return Buffer.from(pcm16ToWav(new Int16Array(samples), DASHSCOPE_HTTP_SAMPLE_RATE));
}

export async function probeBailianTranscription(options: {
  endpoint: string;
  apiKey: string;
  model: string;
  timeoutMs?: number;
}): Promise<ProviderTestResult> {
  const started = Date.now();
  try {
    await transcribeWithBailian({
      endpoint: options.endpoint,
      apiKey: options.apiKey,
      model: options.model || DASHSCOPE_HTTP_MODEL,
      audio: silenceWav(1000),
      mimeType: "audio/wav",
      signal: AbortSignal.timeout(Math.max(5000, options.timeoutMs ?? 30000)),
    });
    return {
      ok: true,
      message: "连接成功（百炼 HTTP 语音识别可用）",
      latencyMs: Date.now() - started,
    };
  } catch (error) {
    const message = error instanceof AppError ? error.message : (error as Error).message;
    return { ok: false, message, latencyMs: Date.now() - started };
  }
}
