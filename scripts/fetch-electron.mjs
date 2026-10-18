import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const version = process.env.DH_ELECTRON_VERSION || "29.4.6";
const target = "win32-x64";
const archiveName = "electron-v" + version + "-" + target + ".zip";
const mirror = (process.env.DH_ELECTRON_MIRROR || "https://registry.npmmirror.com/-/binary/electron").replace(/\/+$/, "");
const cacheDir = join(root, "work", "electron-cache");
const archivePath = join(cacheDir, archiveName);
const sumsPath = join(cacheDir, "SHASUMS256-" + version + ".txt");
const runtimeDir = join(root, "work", "e2e-runtime");
const runtimeExe = join(runtimeDir, "Desktophelper.exe");
const force = process.argv.includes("--force");

function log(message) {
  console.log("[fetch-electron] " + message);
}

async function sha256(file) {
  const hash = createHash("sha256");
  await new Promise((resolvePromise, reject) => {
    const stream = createReadStream(file);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", resolvePromise);
    stream.on("error", reject);
  });
  return hash.digest("hex");
}

async function download(url, destination) {
  const partial = destination + ".part";
  await rm(partial, { force: true });
  log("downloading " + url);
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok || !response.body) {
    throw new Error("download failed: HTTP " + response.status + " " + response.statusText);
  }
  const total = Number(response.headers.get("content-length") || 0);
  let received = 0;
  let lastPercent = -1;
  const body = Readable.fromWeb(response.body);
  body.on("data", (chunk) => {
    received += chunk.length;
    if (total > 0) {
      const percent = Math.floor((received / total) * 100);
      if (percent >= lastPercent + 5 || percent === 100) {
        lastPercent = percent;
        log("  " + percent + "% (" + (received / 1024 / 1024).toFixed(1) + " / " + (total / 1024 / 1024).toFixed(1) + " MiB)");
      }
    }
  });
  await pipeline(body, createWriteStream(partial));
  if (total > 0 && received !== total) {
    throw new Error("incomplete download: expected " + total + " bytes, received " + received);
  }
  await rm(destination, { force: true });
  await rename(partial, destination);
}

async function expectedHash() {
  if (!existsSync(sumsPath)) {
    await download(mirror + "/v" + version + "/SHASUMS256.txt", sumsPath);
  }
  const text = await readFile(sumsPath, "utf8");
  const line = text.split(/\r?\n/).find((entry) => entry.trim().endsWith(archiveName));
  if (!line) throw new Error("no checksum for " + archiveName + " in SHASUMS256.txt");
  return line.trim().split(/\s+/)[0].toLowerCase();
}

async function ensureArchive() {
  const expected = await expectedHash();
  if (existsSync(archivePath) && !force) {
    const actual = await sha256(archivePath);
    if (actual === expected) {
      log("archive cache is valid: " + archivePath);
      return;
    }
    log("cached archive checksum mismatch; downloading again");
  }
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await download(mirror + "/v" + version + "/" + archiveName, archivePath);
      const actual = await sha256(archivePath);
      if (actual !== expected) {
        await rm(archivePath, { force: true });
        throw new Error("checksum mismatch: expected " + expected + ", got " + actual);
      }
      log("checksum verified: " + actual);
      return;
    } catch (error) {
      lastError = error;
      log("attempt " + attempt + " failed: " + error.message);
    }
  }
  throw lastError;
}

async function installRuntime() {
  if (existsSync(runtimeExe) && !force) {
    log("runtime already installed: " + runtimeExe);
    log("use --force to reinstall from the verified archive");
    return;
  }
  const staging = runtimeDir + ".new";
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true });
  log("extracting " + archiveName);
  const tar = spawnSync("tar.exe", ["-xf", archivePath, "-C", staging], { stdio: "inherit" });
  if (tar.status !== 0) throw new Error("failed to extract Electron archive with tar.exe");
  const extractedExe = join(staging, "electron.exe");
  if (!existsSync(extractedExe)) throw new Error("archive does not contain electron.exe");
  await rename(extractedExe, join(staging, "Desktophelper.exe"));
  const info = {
    name: "Desktophelper",
    electronVersion: version,
    target: target,
    source: mirror + "/v" + version + "/" + archiveName,
    installedAt: new Date().toISOString(),
  };
  await writeFile(join(staging, "runtime-info.json"), JSON.stringify(info, null, 2) + "\n", "utf8");
  await rm(runtimeDir, { recursive: true, force: true });
  await rename(staging, runtimeDir);
  log("runtime ready: " + runtimeExe);
}

async function main() {
  if (process.platform !== "win32") {
    throw new Error("Desktophelper currently targets Windows; run this script on Windows 10/11.");
  }
  await mkdir(cacheDir, { recursive: true });
  await ensureArchive();
  await installRuntime();
  console.log("");
  console.log("Electron " + version + " is ready.");
  console.log("Next: .\\start.cmd  (or: node scripts/run-electron.mjs)");
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exitCode = 1;
});