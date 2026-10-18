import { copyFile, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export type JsonValidator<T> = (value: unknown) => T;

export async function readJsonFile<T>(file: string, fallback: T, validate?: JsonValidator<T>): Promise<T> {
  try {
    const raw = await readFile(file, "utf8");
    const parsed: unknown = JSON.parse(raw);
    return validate ? validate(parsed) : (parsed as T);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      try {
        await copyFile(file, `${file}.corrupt-${Date.now()}`);
      } catch {
        // ignore backup failure
      }
    }
    return fallback;
  }
}

export async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temp, JSON.stringify(value, null, 2), "utf8");
  try {
    await rename(temp, file);
  } catch {
    try {
      await unlink(file);
    } catch {
      // ignore missing destination
    }
    await rename(temp, file);
  }
}

export async function readTextFile(file: string): Promise<Buffer> {
  return readFile(file);
}