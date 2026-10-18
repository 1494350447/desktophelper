import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { assertSafeZipEntries } from "./zip-safety.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "out");
const distDir = join(root, "dist");
const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const product = pkg.productName ?? "Desktophelper";
const version = pkg.version ?? "0.0.0";
const stageName = product + "-" + version + "-win-x64";
const stageDir = join(distDir, stageName);
const zipPath = join(distDir, stageName + ".zip");

const runtimeExeNames = ["electron.exe", "Desktophelper.exe"];

function resolveRuntime() {
  const candidates = [
    process.env.DH_ELECTRON_DIR,
    join(root, "work", "e2e-runtime"),
    join(root, "work", "electron-cache", "v29.4.6"),
  ].filter(Boolean);
  for (const candidate of candidates) {
    const directory = resolve(candidate);
    const exe = runtimeExeNames.find((name) => existsSync(join(directory, name)));
    if (exe) return { directory, exe };
  }
  return null;
}

function assertInside(base, target) {
  const rel = relative(base, target);
  if (!rel || rel.startsWith("..") || isAbsolute(rel) || rel.split(sep).includes("..")) {
    throw new Error("unsafe path: " + target + " is not inside " + base);
  }
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

async function main() {
  const runtime = resolveRuntime();
  if (!runtime) {
    throw new Error(
      "missing Electron runtime.\n" +
        "Run: node scripts/fetch-electron.mjs\n" +
        "or set DH_ELECTRON_DIR to a directory containing electron.exe.",
    );
  }
  assertInside(distDir, stageDir);

  const build = spawnSync(process.execPath, [join(root, "scripts", "build.mjs")], {
    cwd: root,
    stdio: "inherit",
  });
  if (build.status !== 0) throw new Error("build failed");

  await rm(stageDir, { recursive: true, force: true });
  await mkdir(stageDir, { recursive: true });

  for (const entry of await readdir(runtime.directory, { withFileTypes: true })) {
    if (entry.name === "resources") continue;
    if (entry.name === "runtime-info.json") continue;
    if (entry.name === runtime.exe) continue;
    if (/^Uninstall.*\.exe$/i.test(entry.name)) continue;
    const source = join(runtime.directory, entry.name);
    const target = join(stageDir, entry.name);
    await cp(source, target, { recursive: true, force: true });
  }
  await cp(join(runtime.directory, runtime.exe), join(stageDir, product + ".exe"), { force: true });

  const appDir = join(stageDir, "resources", "app");
  await mkdir(appDir, { recursive: true });
  for (const entry of await readdir(outDir)) {
    await cp(join(outDir, entry), join(appDir, entry), { recursive: true, force: true });
  }

  const appPackage = {
    name: "desktophelper-app",
    productName: product,
    version,
    private: true,
    description: pkg.description,
    type: "module",
    main: "main/index.mjs",
  };
  await writeFile(join(appDir, "package.json"), JSON.stringify(appPackage, null, 2) + "\n", "utf8");

  const readme = [
    product + " " + version,
    "",
    "启动方式：双击同目录下的 " + product + ".exe",
    "",
    "说明：",
    "1. 这是免安装的便携版，整个文件夹可以复制到任意位置。",
    "2. 首次运行若出现 Windows SmartScreen 提示，请选择“更多信息”再选“仍要运行”。",
    "3. 配置、截图与知识库默认保存在 %APPDATA%\\DesktophelperRewrite。",
    "4. 请不要只复制 exe 文件，必须保留 resources、locales 等同级文件。",
    "5. 卸载：目录版删除本文件夹；单文件版删除 Portable exe 与 %LOCALAPPDATA%\\DesktophelperApp。",
    "6. 用户数据位于 %APPDATA%\\DesktophelperRewrite，可按需删除。",
    "",
    "常用快捷键：",
    "Ctrl+H      区域截图",
    "Ctrl+Enter  解题",
    "Ctrl+M      收音开关",
    "",
  ].join("\r\n");
  await writeFile(join(stageDir, "README.txt"), "\ufeff" + readme, "utf8");

  if (existsSync(zipPath)) await rm(zipPath, { force: true });
  const tar = spawnSync("tar.exe", ["-a", "-c", "-f", zipPath, "-C", distDir, stageName], {
    cwd: root,
    stdio: "inherit",
  });
  if (tar.status !== 0) throw new Error("failed to create zip archive");
  assertSafeZipEntries(zipPath);

  const zipHash = await sha256(zipPath);
  await writeFile(join(distDir, "SHA256SUMS.txt"), zipHash + "  " + stageName + ".zip\r\n", "utf8");

  console.log("");
  console.log("package ready:");
  console.log("  " + join(stageDir, product + ".exe"));
  console.log("  " + zipPath);
  console.log("sha256: " + zipHash);
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exitCode = 1;
});