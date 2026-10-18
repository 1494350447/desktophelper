import { cp, mkdir, readdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const workspace = root;

const executableNames = ["Desktophelper.exe", "electron.exe"];

function inspectRuntime(directory) {
  if (!directory) return null;
  const resolved = resolve(directory);
  const exe = executableNames.find((name) => existsSync(join(resolved, name)));
  return exe ? { root: resolved, exe } : null;
}

const candidates = [
  process.env.DH_RUNTIME_DIR,
  join(root, "work", "e2e-runtime"),
  join(root, "work", "electron-cache", "v29.4.6"),
];
const selected = candidates.map(inspectRuntime).find(Boolean) ?? {
  root: join(root, "work", "e2e-runtime"),
  exe: "Desktophelper.exe",
};

export const runtimeRoot = selected.root;
export const resourcesDir = join(runtimeRoot, "resources");
export const appDir = join(resourcesDir, "app");
export const executable = join(runtimeRoot, selected.exe);

function assertSafeTarget(target) {
  if (!target.startsWith(runtimeRoot + sep)) throw new Error("target escapes runtime root: " + target);
}

export function requireRuntime() {
  if (!existsSync(executable)) {
    throw new Error(
      "No Electron runtime found at " + executable + ".\n" +
        "Run: node scripts/fetch-electron.mjs",
    );
  }
}

export async function deployApp() {
  requireRuntime();
  assertSafeTarget(appDir);
  if (appDir !== join(resourcesDir, "app")) throw new Error("unexpected app directory: " + appDir);
  await rm(appDir, { recursive: true, force: true });
  await mkdir(appDir, { recursive: true });
  const outDir = join(root, "out");
  for (const entry of await readdir(outDir)) {
    await cp(join(outDir, entry), join(appDir, entry), { recursive: true, force: true });
  }
  return appDir;
}