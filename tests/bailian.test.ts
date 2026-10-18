import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import {
  BAILIAN_MAX_AUDIO_BYTES,
  buildBailianPayload,
  describeBailianHttpError,
  normalizeBailianEndpoint,
  parseBailianTranscription,
  probeBailianTranscription,
  transcribeWithBailian,
} from "../src/main/bailian.ts";
import {
  DASHSCOPE_HTTP_ENDPOINT,
  DASHSCOPE_HTTP_MODEL,
} from "../src/shared/models.ts";
import { AppError } from "../src/shared/result.ts";

type Captured = {
  authorization: string;
  contentType: string;
  sse: string;
  body: Record<string, unknown>;
};

async function serve(
  t: test.TestContext,
  handler: (captured: Captured) => { status: number; body: unknown },
): Promise<{ endpoint: string; requests: Captured[] }> {
  const requests: Captured[] = [];
  const server: Server = createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk: Buffer) => {
      raw += chunk.toString("utf8");
    });
    request.on("end", () => {
      const captured: Captured = {
        authorization: String(request.headers.authorization ?? ""),
        contentType: String(request.headers["content-type"] ?? ""),
        sse: String(request.headers["x-dashscope-sse"] ?? ""),
        body: raw ? (JSON.parse(raw) as Record<string, unknown>) : {},
      };
      requests.push(captured);
      const result = handler(captured);
      response.writeHead(result.status, { "content-type": "application/json" });
      response.end(JSON.stringify(result.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections?.();
    server.close();
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no server address");
  return { endpoint: `http://127.0.0.1:${address.port}`, requests };
}

test("normalizeBailianEndpoint keeps a complete generation URL", () => {
  assert.equal(
    normalizeBailianEndpoint("https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation"),
    "https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation",
  );
});

test("normalizeBailianEndpoint expands base URLs and trims query strings", () => {
  assert.equal(
    normalizeBailianEndpoint("https://dashscope.aliyuncs.com/api/v1?x=1"),
    "https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation",
  );
  assert.equal(
    normalizeBailianEndpoint("https://dashscope.aliyuncs.com"),
    "https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation",
  );
  assert.equal(
    normalizeBailianEndpoint("https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation"),
    "https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation",
  );
});

test("normalizeBailianEndpoint falls back to the configured endpoint", () => {
  assert.equal(normalizeBailianEndpoint("  "), DASHSCOPE_HTTP_ENDPOINT);
});

test("normalizeBailianEndpoint rejects invalid URLs", () => {
  assert.throws(
    () => normalizeBailianEndpoint("ftp://dashscope.aliyuncs.com"),
    (error: unknown) => error instanceof AppError && error.code === "VALIDATION",
  );
});

test("buildBailianPayload sends a base64 wav data URL", () => {
  const audio = Buffer.from("wav-bytes");
  const payload = buildBailianPayload({ model: DASHSCOPE_HTTP_MODEL, audio, mimeType: "audio/wav" });
  const input = payload.input as { messages: Array<{ content: Array<Record<string, unknown>> }> };
  const part = input.messages[0].content[0] as {
    type: string;
    input_audio: { data: string };
  };
  assert.equal(payload.model, DASHSCOPE_HTTP_MODEL);
  assert.deepEqual(payload.parameters, { format: "wav", sample_rate: "16000" });
  assert.equal(part.type, "input_audio");
  assert.equal(part.input_audio.data, `data:audio/wav;base64,${audio.toString("base64")}`);
});

test("parseBailianTranscription reads output.text and fallbacks", () => {
  assert.equal(parseBailianTranscription({ output: { text: " 你好 " } }), "你好");
  assert.equal(parseBailianTranscription({ output: { sentence: { text: "句子结果" } } }), "句子结果");
  assert.equal(
    parseBailianTranscription({ output: { sentences: [{ text: "第一句" }, { text: "第二句" }] } }),
    "第一句第二句",
  );
  assert.equal(parseBailianTranscription({ output: {} }), "");
});

test("describeBailianHttpError maps auth failures", () => {
  const unauthorized = describeBailianHttpError(401, { code: "InvalidApiKey", message: "bad key" });
  assert.equal(unauthorized.code, "UNAUTHORIZED");
  assert.match(unauthorized.message, /鉴权失败/);
  const forbidden = describeBailianHttpError(403, { error: { code: "Forbidden", message: "denied" } });
  assert.equal(forbidden.code, "UNAUTHORIZED");
  const limited = describeBailianHttpError(429, { code: "Throttling", message: "slow down" });
  assert.equal(limited.code, "LIMIT");
});

test("transcribeWithBailian posts authorization and wav data", async (t) => {
  const { endpoint, requests } = await serve(t, (captured) => {
    const input = captured.body.input as {
      messages: Array<{ content: Array<{ input_audio: { data: string } }> }>;
    };
    assert.match(input.messages[0].content[0].input_audio.data, /^data:audio\/wav;base64,UklGR/);
    return { status: 200, body: { output: { text: "识别成功" } } };
  });

  const text = await transcribeWithBailian({
    endpoint,
    apiKey: "test-key",
    model: DASHSCOPE_HTTP_MODEL,
    audio: Buffer.from("RIFFxxxxWAVE"),
    mimeType: "audio/wav",
  });

  assert.equal(text, "识别成功");
  assert.equal(requests.length, 1);
  assert.equal(requests[0].authorization, "Bearer test-key");
  assert.equal(requests[0].contentType, "application/json");
  assert.equal(requests[0].sse, "disable");
  assert.equal(requests[0].body.model, DASHSCOPE_HTTP_MODEL);
});

test("transcribeWithBailian rejects oversized audio before upload", async () => {
  await assert.rejects(
    transcribeWithBailian({
      endpoint: DASHSCOPE_HTTP_ENDPOINT,
      apiKey: "test-key",
      model: DASHSCOPE_HTTP_MODEL,
      audio: Buffer.alloc(BAILIAN_MAX_AUDIO_BYTES + 1),
    }),
    (error: unknown) => error instanceof AppError && error.code === "LIMIT",
  );
});

test("transcribeWithBailian maps 401 responses", async (t) => {
  const { endpoint, requests } = await serve(t, () => ({
    status: 401,
    body: { code: "InvalidApiKey", message: "invalid api key", request_id: "req_1" },
  }));
  await assert.rejects(
    transcribeWithBailian({
      endpoint,
      apiKey: "wrong",
      model: DASHSCOPE_HTTP_MODEL,
      audio: Buffer.from("wav"),
    }),
    (error: unknown) => error instanceof AppError && error.code === "UNAUTHORIZED",
  );
  assert.equal(requests[0].authorization, "Bearer wrong");
});

test("probeBailianTranscription reports a working endpoint", async (t) => {
  const { endpoint, requests } = await serve(t, () => ({ status: 200, body: { output: { text: "" } } }));
  const result = await probeBailianTranscription({ endpoint, apiKey: "test-key", model: DASHSCOPE_HTTP_MODEL });
  assert.equal(result.ok, true);
  assert.match(result.message, /连接成功/);
  assert.equal(requests.length, 1);
  const input = requests[0].body.input as {
    messages: Array<{ content: Array<{ input_audio: { data: string } }> }>;
  };
  const base64 = input.messages[0].content[0].input_audio.data.split(",")[1];
  const wav = Buffer.from(base64, "base64");
  assert.equal(wav.subarray(0, 4).toString("ascii"), "RIFF");
  assert.equal(wav.subarray(8, 12).toString("ascii"), "WAVE");
});
