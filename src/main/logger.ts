import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

export type LogLevel = "debug" | "info" | "warn" | "error";

export class Logger {
  readonly file: string;
  private queue: Promise<void> = Promise.resolve();

  constructor(dataDir: string) {
    const stamp = new Date().toISOString().slice(0, 10);
    this.file = join(dataDir, "logs", `app-${stamp}.log`);
  }

  async init(): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true });
  }

  log(level: LogLevel, message: string, details?: unknown): void {
    const line = JSON.stringify({
      t: new Date().toISOString(),
      level,
      message,
      ...(details === undefined ? {} : { details }),
    });
    this.queue = this.queue
      .then(() => appendFile(this.file, `${line}\n`, "utf8"))
      .catch(() => undefined);
  }

  debug(message: string, details?: unknown): void {
    this.log("debug", message, details);
  }

  info(message: string, details?: unknown): void {
    this.log("info", message, details);
  }

  warn(message: string, details?: unknown): void {
    this.log("warn", message, details);
  }

  error(message: string, details?: unknown): void {
    this.log("error", message, details);
  }
}