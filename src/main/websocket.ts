import { createHash, randomBytes } from "node:crypto";
import { connect as netConnect, isIP, type Socket } from "node:net";
import { connect as tlsConnect, type TLSSocket } from "node:tls";

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const DEFAULT_MAX_MESSAGE_BYTES = 8 * 1024 * 1024;
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 15000;
const MAX_HANDSHAKE_BYTES = 64 * 1024;

export type WebSocketData = string | Uint8Array;

export type WebSocketLike = {
  readonly bufferedAmount: number;
  readonly readyState: number;
  sendText: (text: string) => boolean;
  sendBinary: (data: Uint8Array) => boolean;
  ping: (payload?: Uint8Array) => void;
  close: (code?: number, reason?: string) => void;
  terminate: () => void;
  onOpen: (listener: () => void) => () => void;
  onMessage: (listener: (data: WebSocketData) => void) => () => void;
  onClose: (listener: (code: number, reason: string) => void) => () => void;
  onError: (listener: (error: Error) => void) => () => void;
};

export type WebSocketConnectOptions = {
  headers?: Record<string, string>;
  handshakeTimeoutMs?: number;
  maxMessageBytes?: number;
};

function safeHeader(name: string, value: string): string | null {
  const cleanName = name.replace(/[\r\n]/g, "").trim();
  const cleanValue = value.replace(/[\r\n]/g, " ").trim();
  if (!cleanName || !cleanValue) return null;
  return `${cleanName}: ${cleanValue}`;
}

function parseHandshake(head: string): { statusCode: number; headers: Record<string, string> } {
  const lines = head.split("\r\n");
  const status = /^HTTP\/\d\.\d\s+(\d{3})/.exec(lines[0] ?? "");
  const headers: Record<string, string> = {};
  for (const line of lines.slice(1)) {
    const index = line.indexOf(":");
    if (index <= 0) continue;
    headers[line.slice(0, index).trim().toLowerCase()] = line.slice(index + 1).trim();
  }
  return { statusCode: status ? Number(status[1]) : 0, headers };
}

function unmask(payload: Buffer, mask: Buffer): Buffer {
  const output = Buffer.allocUnsafe(payload.length);
  for (let index = 0; index < payload.length; index += 1) {
    output[index] = payload[index] ^ mask[index & 3];
  }
  return output;
}

export class NodeWebSocket implements WebSocketLike {
  readonly url: URL;
  private readonly headers: Record<string, string>;
  private readonly handshakeTimeoutMs: number;
  private readonly maxMessageBytes: number;

  private socket: Socket | TLSSocket | null = null;
  private state = 0;
  private rx: Buffer = Buffer.alloc(0);
  private handshakeBuffer: Buffer = Buffer.alloc(0);
  private fragments: Buffer[] = [];
  private fragmentOpcode = 0;
  private fragmentBytes = 0;
  private closeEmitted = false;
  private closeSent = false;
  private closeInfo: { code: number; reason: string } | null = null;
  private lastError: Error | null = null;
  private closeTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly openListeners = new Set<() => void>();
  private readonly messageListeners = new Set<(data: WebSocketData) => void>();
  private readonly closeListeners = new Set<(code: number, reason: string) => void>();
  private readonly errorListeners = new Set<(error: Error) => void>();
  private pendingMessages: WebSocketData[] = [];
  private pendingBytes = 0;

  constructor(url: URL, options: WebSocketConnectOptions = {}) {
    this.url = url;
    this.headers = options.headers ?? {};
    this.handshakeTimeoutMs = Math.max(1000, options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS);
    this.maxMessageBytes = Math.max(64 * 1024, options.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES);
  }

  get bufferedAmount(): number {
    return this.socket?.writableLength ?? 0;
  }

  get readyState(): number {
    return this.state;
  }

  onOpen(listener: () => void): () => void {
    if (this.state === 1) {
      queueMicrotask(listener);
      return () => undefined;
    }
    this.openListeners.add(listener);
    return () => this.openListeners.delete(listener);
  }

  onMessage(listener: (data: WebSocketData) => void): () => void {
    this.messageListeners.add(listener);
    if (this.pendingMessages.length > 0) {
      const pending = this.pendingMessages;
      this.pendingMessages = [];
      this.pendingBytes = 0;
      queueMicrotask(() => {
        if (!this.messageListeners.has(listener)) return;
        for (const message of pending) listener(message);
      });
    }
    return () => this.messageListeners.delete(listener);
  }

  onClose(listener: (code: number, reason: string) => void): () => void {
    if (this.closeEmitted && this.closeInfo) {
      queueMicrotask(() => listener(this.closeInfo!.code, this.closeInfo!.reason));
      return () => undefined;
    }
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  onError(listener: (error: Error) => void): () => void {
    if (this.lastError) {
      queueMicrotask(() => listener(this.lastError!));
      return () => undefined;
    }
    this.errorListeners.add(listener);
    return () => this.errorListeners.delete(listener);
  }

  sendText(text: string): boolean {
    if (this.state !== 1) return false;
    return this.writeFrame(0x1, Buffer.from(text, "utf8"));
  }

  sendBinary(data: Uint8Array): boolean {
    if (this.state !== 1) return false;
    return this.writeFrame(0x2, Buffer.from(data));
  }

  ping(payload?: Uint8Array): void {
    if (this.state !== 1) return;
    const body = payload ? Buffer.from(payload).subarray(0, 125) : Buffer.alloc(0);
    this.writeFrame(0x9, body);
  }

  close(code = 1000, reason = ""): void {
    if (this.state === 3 || this.closeSent) return;
    this.closeSent = true;
    if (this.state === 0) {
      this.terminate();
      return;
    }
    if (this.state === 1) {
      const body = Buffer.alloc(2 + Buffer.byteLength(reason, "utf8"));
      body.writeUInt16BE(code, 0);
      body.write(reason, 2, "utf8");
      this.writeFrame(0x8, body.subarray(0, 125));
      this.state = 2;
      this.socket?.end();
      this.closeTimer = setTimeout(() => this.socket?.destroy(), 1000);
      if (typeof this.closeTimer.unref === "function") this.closeTimer.unref();
    }
    this.emitClose(code, reason);
  }

  terminate(): void {
    this.state = 3;
    this.socket?.destroy();
    this.emitClose(1006, "连接已终止");
  }

  async connect(): Promise<void> {
    const secure = this.url.protocol === "wss:";
    if (!secure && this.url.protocol !== "ws:") {
      throw new Error(`不支持的 WebSocket 协议：${this.url.protocol}`);
    }
    const host = this.url.hostname;
    const port = this.url.port ? Number(this.url.port) : secure ? 443 : 80;
    const key = randomBytes(16).toString("base64");
    const expectedAccept = createHash("sha1").update(`${key}${WS_GUID}`).digest("base64");
    const hostForHeader = host.includes(":") ? `[${host}]` : host;
    const hostHeader = this.url.port ? `${hostForHeader}:${this.url.port}` : hostForHeader;
    const path = `${this.url.pathname || "/"}${this.url.search}`;
    const extraHeaders = Object.entries(this.headers)
      .map(([name, value]) => safeHeader(name, value))
      .filter((line): line is string => Boolean(line));
    const request = [
      `GET ${path} HTTP/1.1`,
      `Host: ${hostHeader}`,
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Key: ${key}`,
      "Sec-WebSocket-Version: 13",
      ...extraHeaders,
      "",
      "",
    ].join("\r\n");

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        fail(new Error("WebSocket 连接超时"));
      }, this.handshakeTimeoutMs);
      if (typeof timer.unref === "function") timer.unref();

      const cleanup = () => {
        clearTimeout(timer);
      };
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        this.lastError = error;
        this.state = 3;
        this.socket?.destroy();
        this.emitError(error);
        this.emitClose(1006, error.message);
        reject(error);
      };

      const socket = secure
        ? tlsConnect({
            host,
            port,
            servername: isIP(host) === 0 ? host : undefined,
            ALPNProtocols: ["http/1.1"],
          })
        : netConnect({ host, port });
      this.socket = socket;
      socket.setNoDelay(true);

      socket.on("error", (error: Error) => {
        if (!settled) fail(error);
        else this.emitError(error);
      });
      socket.on("close", () => {
        if (!settled) fail(new Error("WebSocket 连接已关闭"));
        else this.handleSocketClose();
      });
      socket.once(secure ? "secureConnect" : "connect", () => {
        socket.write(request, "latin1");
      });
      socket.on("data", (chunk: Buffer) => {
        if (settled) {
          this.handleData(chunk);
          return;
        }
        this.handshakeBuffer = Buffer.concat([this.handshakeBuffer, chunk]);
        if (this.handshakeBuffer.length > MAX_HANDSHAKE_BYTES) {
          fail(new Error("WebSocket 握手响应过大"));
          return;
        }
        const headerEnd = this.handshakeBuffer.indexOf("\r\n\r\n");
        if (headerEnd < 0) return;
        const head = this.handshakeBuffer.subarray(0, headerEnd).toString("latin1");
        const rest = this.handshakeBuffer.subarray(headerEnd + 4);
        this.handshakeBuffer = Buffer.alloc(0);
        const parsed = parseHandshake(head);
        if (parsed.statusCode !== 101) {
          const detail = rest.toString("utf8").replace(/\s+/g, " ").trim().slice(0, 300);
          fail(new Error(`WebSocket 握手失败：HTTP ${parsed.statusCode}${detail ? `：${detail}` : ""}`));
          return;
        }
        if (parsed.headers["sec-websocket-accept"] !== expectedAccept) {
          fail(new Error("WebSocket 握手校验失败"));
          return;
        }
        settled = true;
        cleanup();
        this.state = 1;
        this.emitOpen();
        if (rest.length > 0) this.handleData(rest);
        resolve();
      });
    });
  }

  private writeFrame(opcode: number, payload: Buffer): boolean {
    if (this.state !== 1 || !this.socket) return false;
    const length = payload.length;
    let header: Buffer;
    if (length < 126) {
      header = Buffer.allocUnsafe(2);
      header[1] = 0x80 | length;
    } else if (length < 65536) {
      header = Buffer.allocUnsafe(4);
      header[1] = 0x80 | 126;
      header.writeUInt16BE(length, 2);
    } else {
      header = Buffer.allocUnsafe(10);
      header[1] = 0x80 | 127;
      header.writeBigUInt64BE(BigInt(length), 2);
    }
    header[0] = 0x80 | opcode;
    const mask = randomBytes(4);
    const masked = Buffer.allocUnsafe(length);
    for (let index = 0; index < length; index += 1) {
      masked[index] = payload[index] ^ mask[index & 3];
    }
    try {
      this.socket.write(Buffer.concat([header, mask, masked]));
    } catch (error) {
      this.emitError(error instanceof Error ? error : new Error(String(error)));
      return false;
    }
    return this.socket.writableLength < 1024 * 1024;
  }

  private handleData(chunk: Buffer): void {
    if (this.state === 3) return;
    this.rx = this.rx.length === 0 ? chunk : Buffer.concat([this.rx, chunk]);
    while (this.rx.length >= 2) {
      const first = this.rx[0];
      const second = this.rx[1];
      const fin = (first & 0x80) !== 0;
      const rsv = first & 0x70;
      const opcode = first & 0x0f;
      const masked = (second & 0x80) !== 0;
      let length = second & 0x7f;
      let offset = 2;
      if (rsv !== 0) {
        this.failProtocol("WebSocket 使用了不支持的扩展位");
        return;
      }
      if (length === 126) {
        if (this.rx.length < 4) return;
        length = this.rx.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (this.rx.length < 10) return;
        const bigLength = this.rx.readBigUInt64BE(2);
        if (bigLength > BigInt(this.maxMessageBytes)) {
          this.failProtocol("WebSocket 消息过大");
          return;
        }
        length = Number(bigLength);
        offset = 10;
      }
      if (length > this.maxMessageBytes) {
        this.failProtocol("WebSocket 消息过大");
        return;
      }
      const maskLength = masked ? 4 : 0;
      if (this.rx.length < offset + maskLength + length) return;
      const mask = masked ? this.rx.subarray(offset, offset + 4) : null;
      const raw = this.rx.subarray(offset + maskLength, offset + maskLength + length);
      const payload = mask ? unmask(raw, mask) : Buffer.from(raw);
      this.rx = this.rx.subarray(offset + maskLength + length);
      this.handleFrame(fin, opcode, payload);
      if (this.state === 3) return;
    }
  }

  private handleFrame(fin: boolean, opcode: number, payload: Buffer): void {
    if (opcode >= 0x8) {
      if (!fin || payload.length > 125) {
        this.failProtocol("WebSocket 控制帧格式错误");
        return;
      }
      if (opcode === 0x8) {
        const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
        const reason = payload.length > 2 ? payload.subarray(2).toString("utf8") : "";
        if (this.state === 1) {
          this.writeFrame(0x8, payload.subarray(0, Math.min(payload.length, 125)));
          this.state = 2;
          this.socket?.end();
          this.closeTimer = setTimeout(() => this.socket?.destroy(), 500);
          if (typeof this.closeTimer.unref === "function") this.closeTimer.unref();
        }
        this.closeSent = true;
        this.emitClose(code, reason);
        return;
      }
      if (opcode === 0x9) {
        if (this.state === 1) this.writeFrame(0xa, payload);
        return;
      }
      if (opcode === 0xa) return;
      this.failProtocol(`WebSocket 不支持的操作码：${opcode}`);
      return;
    }

    if (opcode === 0x0) {
      if (this.fragmentOpcode === 0) {
        this.failProtocol("WebSocket 续帧缺少起始帧");
        return;
      }
      this.fragmentBytes += payload.length;
      if (this.fragmentBytes > this.maxMessageBytes) {
        this.failProtocol("WebSocket 消息过大");
        return;
      }
      this.fragments.push(payload);
      if (!fin) return;
      const complete = Buffer.concat(this.fragments);
      const messageOpcode = this.fragmentOpcode;
      this.fragments = [];
      this.fragmentOpcode = 0;
      this.fragmentBytes = 0;
      this.deliver(messageOpcode, complete);
      return;
    }

    if (opcode !== 0x1 && opcode !== 0x2) {
      this.failProtocol(`WebSocket 不支持的操作码：${opcode}`);
      return;
    }
    if (!fin) {
      this.fragmentOpcode = opcode;
      this.fragments = [payload];
      this.fragmentBytes = payload.length;
      return;
    }
    this.deliver(opcode, payload);
  }

  private deliver(opcode: number, payload: Buffer): void {
    const data: WebSocketData = opcode === 0x1 ? payload.toString("utf8") : new Uint8Array(payload);
    if (this.messageListeners.size === 0) {
      this.pendingMessages.push(data);
      this.pendingBytes += payload.length;
      while (this.pendingMessages.length > 512 || this.pendingBytes > this.maxMessageBytes) {
        const dropped = this.pendingMessages.shift();
        if (dropped) this.pendingBytes -= typeof dropped === "string" ? Buffer.byteLength(dropped) : dropped.byteLength;
      }
      return;
    }
    for (const listener of this.messageListeners) listener(data);
  }

  private failProtocol(message: string): void {
    const error = new Error(message);
    this.lastError = error;
    for (const listener of this.errorListeners) listener(error);
    this.close(1002, message.slice(0, 120));
  }

  private handleSocketClose(): void {
    this.state = 3;
    if (this.closeEmitted) return;
    this.emitClose(1006, "连接已断开");
  }

  private emitOpen(): void {
    for (const listener of this.openListeners) {
      try {
        listener();
      } catch {
        // ignore listener failures
      }
    }
    this.openListeners.clear();
  }

  private emitClose(code: number, reason: string): void {
    if (this.closeEmitted) return;
    this.closeEmitted = true;
    this.closeInfo = { code, reason };
    for (const listener of this.closeListeners) {
      try {
        listener(code, reason);
      } catch {
        // ignore listener failures
      }
    }
    this.closeListeners.clear();
  }

  private emitError(error: Error): void {
    this.lastError = error;
    for (const listener of this.errorListeners) {
      try {
        listener(error);
      } catch {
        // ignore listener failures
      }
    }
    this.errorListeners.clear();
  }
}

export async function connectWebSocket(
  urlString: string,
  options: WebSocketConnectOptions = {},
): Promise<NodeWebSocket> {
  const url = new URL(urlString);
  const client = new NodeWebSocket(url, options);
  await client.connect();
  return client;
}
