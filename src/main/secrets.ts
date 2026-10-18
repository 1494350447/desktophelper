import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { safeStorage } from "electron";
import type { SecretKey, SecretsStatus } from "../shared/models.ts";
import { readJsonFile, writeJsonAtomic } from "./json-file.ts";
import type { Logger } from "./logger.ts";

type LockRecord = { salt: string; hash: string };

type SecretsFile = {
  version: 1;
  values: Partial<Record<SecretKey, string>>;
  lock?: LockRecord;
};

const EMPTY: SecretsFile = { version: 1, values: {} };

export class SecretsStore {
  readonly file: string;
  private data: SecretsFile = { ...EMPTY, values: {} };
  private readonly logger: Logger;
  private encryptionAvailable = false;

  constructor(file: string, logger: Logger) {
    this.file = file;
    this.logger = logger;
  }

  async load(): Promise<void> {
    this.data = await readJsonFile<SecretsFile>(this.file, { ...EMPTY, values: {} });
    if (!this.data || this.data.version !== 1) this.data = { ...EMPTY, values: {} };
    this.data.values = this.data.values ?? {};
    this.encryptionAvailable = safeStorage.isEncryptionAvailable();
  }

  private encrypt(value: string): string {
    if (this.encryptionAvailable) {
      return `enc:${safeStorage.encryptString(value).toString("base64")}`;
    }
    this.logger.warn("safeStorage unavailable, storing secret with base64 only");
    return `b64:${Buffer.from(value, "utf8").toString("base64")}`;
  }

  private decrypt(value: string): string | null {
    try {
      if (value.startsWith("enc:")) {
        return safeStorage.decryptString(Buffer.from(value.slice(4), "base64"));
      }
      if (value.startsWith("b64:")) {
        return Buffer.from(value.slice(4), "base64").toString("utf8");
      }
      return null;
    } catch (error) {
      this.logger.error("failed to decrypt secret", { error: String(error) });
      return null;
    }
  }

  get(key: SecretKey): string | null {
    const stored = this.data.values[key];
    if (!stored) return null;
    return this.decrypt(stored);
  }

  async set(key: SecretKey, value: string): Promise<void> {
    const trimmed = value.trim();
    if (!trimmed) {
      delete this.data.values[key];
    } else {
      this.data.values[key] = this.encrypt(trimmed);
    }
    await this.persist();
  }

  async clear(key: SecretKey): Promise<void> {
    delete this.data.values[key];
    await this.persist();
  }

  status(): SecretsStatus {
    return {
      llm: Boolean(this.data.values.llm),
      transcription: Boolean(this.data.values.transcription),
      vision: Boolean(this.data.values.vision),
      extraction: Boolean(this.data.values.extraction),
      lock: Boolean(this.data.lock),
    };
  }

  get encryption(): boolean {
    return this.encryptionAvailable;
  }

  async setLock(passcode: string): Promise<void> {
    const salt = randomBytes(16).toString("hex");
    const hash = scryptSync(passcode, salt, 32, { N: 16384, r: 8, p: 1 }).toString("hex");
    this.data.lock = { salt, hash };
    await this.persist();
  }

  async clearLock(): Promise<void> {
    delete this.data.lock;
    await this.persist();
  }

  hasLock(): boolean {
    return Boolean(this.data.lock);
  }

  verifyLock(passcode: string): boolean {
    const record = this.data.lock;
    if (!record) return false;
    const candidate = scryptSync(passcode, record.salt, 32, { N: 16384, r: 8, p: 1 });
    const expected = Buffer.from(record.hash, "hex");
    if (candidate.length !== expected.length) return false;
    return timingSafeEqual(candidate, expected);
  }

  private async persist(): Promise<void> {
    await writeJsonAtomic(this.file, this.data);
  }
}
