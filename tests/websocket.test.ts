import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import type { Socket } from "node:net";
import { connectWebSocket, type WebSocketData } from "../src/main/websocket.ts";

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

test("custom WebSocket client completes handshake, frames, ping and close", async (t) => {
  const received: RawFrame[] = [];
  const state = { buffer: Buffer.alloc(0) };
  let serverSocket: Socket | null = null;
  let authHeader = "";
  const server = createServer();
  server.on("upgrade", (request, socket) => {
    serverSocket = socket;
    authHeader = String(request.headers.authorization ?? "");
    upgrade(request, socket);
    socket.on("data", (chunk: Buffer) => {
      for (const frame of decodeFrames(state, chunk)) {
        received.push(frame);
        if (frame.opcode === 0x9) socket.write(encodeFrame(0xa, frame.payload));
        if (frame.opcode === 0x8) {
          socket.write(encodeFrame(0x8, frame.payload.subarray(0, 2)));
          socket.end();
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

  const messages: WebSocketData[] = [];
  const client = await connectWebSocket(`ws://127.0.0.1:${address.port}/ws`, {
    headers: { Authorization: "Bearer test-key" },
    handshakeTimeoutMs: 2000,
  });
  client.onMessage((data) => messages.push(data));
  const closed = new Promise<number>((resolve) => client.onClose((code) => resolve(code)));

  client.sendText("你好");
  client.sendBinary(new Uint8Array([1, 2, 3]));
  client.ping(new Uint8Array([7]));

  const deadline = Date.now() + 2000;
  while (
    !(
      received.some((frame) => frame.opcode === 0x1) &&
      received.some((frame) => frame.opcode === 0x2) &&
      received.some((frame) => frame.opcode === 0x9)
    ) &&
    Date.now() < deadline
  ) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(authHeader, "Bearer test-key");

  const text = received.find((frame) => frame.opcode === 0x1);
  const binary = received.find((frame) => frame.opcode === 0x2);
  assert.equal(text?.payload.toString("utf8"), "你好");
  assert.deepEqual([...(binary?.payload ?? [])], [1, 2, 3]);

  serverSocket?.write(encodeFrame(0x1, Buffer.from("server-message", "utf8")));
  const messageDeadline = Date.now() + 2000;
  while (messages.length === 0 && Date.now() < messageDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(messages[0], "server-message");

  client.close(1000, "done");
  assert.equal(await closed, 1000);
});
