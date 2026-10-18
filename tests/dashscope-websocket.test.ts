import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import type { Socket } from "node:net";
import { DashScopeRealtimeSession } from "../src/main/dashscope.ts";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

function encodeFrame(opcode: number, payload: Buffer): Buffer {
  const length = payload.length;
  let header: Buffer;
  if (length < 126) {
    header = Buffer.from([0x80 | opcode, length]);
  } else if (length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  return Buffer.concat([header, payload]);
}

type RawFrame = { opcode: number; payload: Buffer };

function decodeFrames(state: { buffer: Buffer }, chunk: Buffer): RawFrame[] {
  state.buffer = Buffer.concat([state.buffer, chunk]);
  const frames: RawFrame[] = [];
  while (state.buffer.length >= 2) {
    const first = state.buffer[0];
    const second = state.buffer[1];
    const opcode = first & 0x0f;
    const masked = (second & 0x80) !== 0;
    let length = second & 0x7f;
    let offset = 2;
    if (length === 126) {
      if (state.buffer.length < 4) break;
      length = state.buffer.readUInt16BE(2);
      offset = 4;
    } else if (length === 127) {
      if (state.buffer.length < 10) break;
      length = Number(state.buffer.readBigUInt64BE(2));
      offset = 10;
    }
    const maskLength = masked ? 4 : 0;
    if (state.buffer.length < offset + maskLength + length) break;
    const mask = masked ? state.buffer.subarray(offset, offset + 4) : null;
    const raw = state.buffer.subarray(offset + maskLength, offset + maskLength + length);
    const payload = Buffer.from(raw);
    if (mask) {
      for (let index = 0; index < payload.length; index += 1) payload[index] ^= mask[index & 3];
    }
    state.buffer = state.buffer.subarray(offset + maskLength + length);
    frames.push({ opcode, payload });
  }
  return frames;
}

function upgrade(request: IncomingMessage, socket: Socket): void {
  const key = String(request.headers["sec-websocket-key"] ?? "");
  const accept = createHash("sha1").update(`${key}${GUID}`).digest("base64");
  socket.write(
    [
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${accept}`,
      "",
      "",
    ].join("\r\n"),
  );
}

function resultEvent(text: string, final: boolean): string {
  return JSON.stringify({
    header: { event: "result-generated", task_id: "task-1" },
    payload: {
      output: {
        sentence: {
          sentence_id: 1,
          text,
          sentence_end: final,
          begin_time: 0,
          end_time: final ? 1200 : 600,
        },
      },
    },
  });
}

test("DashScope session speaks the documented WebSocket protocol end to end", async (t) => {
  const framesState = { buffer: Buffer.alloc(0) };
  const runTasks: Array<Record<string, unknown>> = [];
  let audioBytes = 0;
  let authHeader = "";
  let requestPath = "";
  let serverSocket: Socket | null = null;
  let sentPartial = false;

  const server = createServer();
  server.on("upgrade", (request, socket) => {
    serverSocket = socket;
    authHeader = String(request.headers.authorization ?? "");
    requestPath = request.url ?? "";
    upgrade(request, socket);
    socket.on("data", (chunk: Buffer) => {
      for (const frame of decodeFrames(framesState, chunk)) {
        if (frame.opcode === 0x9) {
          socket.write(encodeFrame(0xa, frame.payload));
          continue;
        }
        if (frame.opcode === 0x8) {
          socket.write(encodeFrame(0x8, frame.payload.subarray(0, 2)));
          socket.end();
          continue;
        }
        if (frame.opcode === 0x1) {
          const message = JSON.parse(frame.payload.toString("utf8")) as {
            header?: { action?: string };
          };
          if (message.header?.action === "run-task") {
            runTasks.push(message as Record<string, unknown>);
            socket.write(
              encodeFrame(
                0x1,
                Buffer.from(JSON.stringify({ header: { event: "task-started", task_id: "task-1" }, payload: {} })),
              ),
            );
          } else if (message.header?.action === "finish-task") {
            socket.write(
              encodeFrame(
                0x1,
                Buffer.from(JSON.stringify({ header: { event: "task-finished", task_id: "task-1" }, payload: {} })),
              ),
            );
          }
          continue;
        }
        if (frame.opcode === 0x2) {
          audioBytes += frame.payload.length;
          if (!sentPartial) {
            sentPartial = true;
            socket.write(encodeFrame(0x1, Buffer.from(resultEvent("实时", false))));
          }
          if (audioBytes >= 1600) {
            socket.write(encodeFrame(0x1, Buffer.from(resultEvent("实时识别完成。", true))));
          }
        }
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    serverSocket?.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no server address");

  const partials: string[] = [];
  const finals: string[] = [];
  let resolveFinal: (() => void) | null = null;
  const finalSeen = new Promise<void>((resolve) => {
    resolveFinal = resolve;
  });
  const session = new DashScopeRealtimeSession({
    url: `ws://127.0.0.1:${address.port}/api-ws/v1/inference`,
    apiKey: "test-key",
    model: "qwen-audio-3.1-asr-flash-streaming",
    language: "zh-CN",
    createTaskId: () => "task-1",
    connectTimeoutMs: 2000,
    heartbeatMs: 60000,
    stopFlushMs: 3000,
    onStatus: () => undefined,
    onPartial: (text) => partials.push(text),
    onFinal: (result) => {
      finals.push(result.text);
      resolveFinal?.();
    },
    onError: (message) => assert.fail(message),
  });

  await session.start();
  session.push(new Uint8Array(1600));
  session.push(new Uint8Array(1600));
  await Promise.race([
    finalSeen,
    new Promise((_, reject) => setTimeout(() => reject(new Error("final result timeout")), 3000)),
  ]);

  assert.equal(authHeader, "Bearer test-key");
  assert.equal(requestPath, "/api-ws/v1/inference");
  assert.equal(runTasks.length, 1);
  const parameters = (runTasks[0].payload as { parameters: Record<string, unknown> }).parameters;
  assert.deepEqual(parameters.language_hints, ["zh"]);
  assert.equal(parameters.heartbeat, true);
  assert.equal(parameters.sample_rate, 16000);
  assert.equal(parameters.format, "pcm");
  assert.deepEqual(partials, ["实时", ""]);
  assert.deepEqual(finals, ["实时识别完成。"]);
  assert.equal(audioBytes, 3200);

  await session.stop();
});
