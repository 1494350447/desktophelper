declare function require(id: string): unknown;

type IpcEnvelope = { name: string; payload: unknown };

const electron = require("electron") as {
  contextBridge: { exposeInMainWorld: (key: string, value: unknown) => void };
  ipcRenderer: {
    invoke: (channel: string, payload: unknown) => Promise<unknown>;
    on: (channel: string, listener: (event: unknown, data: IpcEnvelope) => void) => void;
    removeListener: (channel: string, listener: (event: unknown, data: IpcEnvelope) => void) => void;
  };
};

const { contextBridge, ipcRenderer } = electron;

const ALLOWED_EVENTS = new Set([
  "state",
  "answer.delta",
  "answer.reset",
  "answer.done",
  "answer.error",
  "toast",
  "screenshot",
  "screenshot.stage",
  "transcribe.status",
  "transcribe.partial",
  "command",
]);

function invoke(channel: string, payload?: unknown): Promise<unknown> {
  return ipcRenderer.invoke(channel, payload ?? {});
}

function on(event: string, listener: (payload: unknown) => void): () => void {
  if (!ALLOWED_EVENTS.has(event)) return () => undefined;
  const handler = (_event: unknown, data: IpcEnvelope) => {
    if (data && data.name === event) listener(data.payload);
  };
  ipcRenderer.on("dh:event", handler);
  return () => ipcRenderer.removeListener("dh:event", handler);
}

contextBridge.exposeInMainWorld("desktophelper", {
  version: "1.0.0",
  platform: typeof process === "object" && process ? process.platform : "unknown",
  invoke,
  on,
});
