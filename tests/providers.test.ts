import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { streamChat, testProvider } from "../src/main/providers.ts";
import { AppError } from "../src/shared/result.ts";

type Probe = { status: number; body: unknown; raw: string };

async function serve(t: test.TestContext, handler: (raw: string) => Probe): Promise<string> {
  const server: Server = createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk: Buffer) => {
      raw += chunk.toString("utf8");
    });
    request.on("end", () => {
      const probe = handler(raw);
      response.writeHead(probe.status, { "content-type": "application/json" });
      response.end(JSON.stringify(probe.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections?.();
    server.close();
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no server address");
  return `http://127.0.0.1:${address.port}/v1`;
}

async function serveSse(
  t: test.TestContext,
  handler: (index: number, request: Record<string, unknown>) => unknown[],
): Promise<{ baseUrl: string; requests: Array<Record<string, unknown>> }> {
  const requests: Array<Record<string, unknown>> = [];
  const server: Server = createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk: Buffer) => {
      raw += chunk.toString("utf8");
    });
    request.on("end", () => {
      const index = requests.length;
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      requests.push(parsed);
      response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
      for (const frame of handler(index, parsed)) {
        response.write(`data: ${JSON.stringify(frame)}\n\n`);
      }
      response.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections?.();
    server.close();
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no server address");
  return { baseUrl: `http://127.0.0.1:${address.port}/v1`, requests };
}

test("streamChat retries an empty length-limited stream with more tokens", async (t) => {
  const { baseUrl, requests } = await serveSse(t, (index) => {
    if (index === 0) {
      return [
        { choices: [{ delta: { reasoning_content: "thinking" }, finish_reason: null }] },
        { choices: [{ delta: {}, finish_reason: "length" }] },
      ];
    }
    return [
      { choices: [{ delta: { reasoning_content: "thinking" }, finish_reason: null }] },
      { choices: [{ delta: { content: "## 答案\n42" }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: "stop" }] },
    ];
  });
  const deltas: string[] = [];
  await streamChat(
    { provider: "openai", baseUrl, model: "custom-model" },
    "test-key",
    [{ role: "user", content: "hi" }],
    { maxTokens: 900, signal: new AbortController().signal },
    (delta) => deltas.push(delta),
  );
  assert.deepEqual(deltas, ["## 答案\n42"]);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].max_tokens, 900);
  assert.equal(requests[1].max_tokens, 4096);
});

test("deepseek reasoning models start with a 4096 token budget", async (t) => {
  const { baseUrl, requests } = await serveSse(t, () => [
    { choices: [{ delta: { content: "ok" }, finish_reason: null }] },
    { choices: [{ delta: {}, finish_reason: "stop" }] },
  ]);
  const deltas: string[] = [];
  await streamChat(
    { provider: "openai", baseUrl, model: "deepseek-flash" },
    "test-key",
    [{ role: "user", content: "hi" }],
    { maxTokens: 900, signal: new AbortController().signal },
    (delta) => deltas.push(delta),
  );
  assert.deepEqual(deltas, ["ok"]);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].max_tokens, 4096);
});

test("streamChat reports an empty completed response", async (t) => {
  const { baseUrl } = await serveSse(t, () => [
    { choices: [{ delta: {}, finish_reason: "stop" }] },
  ]);
  await assert.rejects(
    streamChat(
      { provider: "openai", baseUrl, model: "custom-model" },
      "test-key",
      [{ role: "user", content: "hi" }],
      { maxTokens: 900, signal: new AbortController().signal },
      () => undefined,
    ),
    (error: unknown) => error instanceof AppError && /空内容/.test(error.message),
  );
});

test("vision connection test sends a real image probe", async (t) => {
  let raw = "";
  const baseUrl = await serve(t, (body) => {
    raw = body;
    return { status: 200, raw: body, body: { choices: [{ message: { content: "OK" } }] } };
  });
  const result = await testProvider(
    "vision",
    { provider: "openai", baseUrl, model: "vision-test" },
    "test-key",
  );
  assert.equal(result.ok, true);
  assert.match(result.message, /图片/);
  const request = JSON.parse(raw) as {
    messages: Array<{ content: Array<{ type: string; image_url?: { url: string } }> }>;
  };
  const content = request.messages[0].content;
  assert.equal(content[1].type, "image_url");
  assert.ok(content[1].image_url?.url.startsWith("data:image/png;base64,"));
});

test("vision connection test reports providers that reject images", async (t) => {
  const baseUrl = await serve(t, () => ({
    status: 400,
    raw: "",
    body: { error: { message: "image input is not supported" } },
  }));
  const result = await testProvider(
    "vision",
    { provider: "openai", baseUrl, model: "vision-test" },
    "test-key",
  );
  assert.equal(result.ok, false);
  assert.match(result.message, /image input is not supported/);
});
