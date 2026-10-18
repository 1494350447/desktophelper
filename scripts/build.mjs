import { stripTypeScriptTypes } from "node:module";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { generateIcon } from "./gen-icon.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = join(root, "src");
const outDir = join(root, "out");

if (!outDir.startsWith(root + sep)) throw new Error("unsafe output directory");
if (outDir === root || root.startsWith(outDir + sep)) throw new Error("refusing to clean project root");

async function listFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await listFiles(full)));
    else if (entry.isFile()) files.push(full);
  }
  return files;
}

function rewriteSpecifiers(code) {
  return code
    .replace(/(from\s+["'])([^"']+?)\.ts(["'])/g, "$1$2.mjs$3")
    .replace(/(import\s*\(\s*["'])([^"']+?)\.ts(["']\s*\))/g, "$1$2.mjs$3")
    .replace(/(import\s+["'])([^"']+?)\.ts(["'])/g, "$1$2.mjs$3");
}

async function emit(sourceFile, targetFile, options = {}) {
  const source = await readFile(sourceFile, "utf8");
  const stripped = stripTypeScriptTypes(source, { mode: "transform" });
  const code = rewriteSpecifiers(stripped);
  const leftover = code.match(/(?:from\s+|import\s*\(\s*)["'][^"']+\.ts["']/);
  if (leftover) throw new Error("unrewritten TypeScript specifier in " + sourceFile + ": " + leftover[0]);
  if (options.commonjs) {
    if (/(^|\n)\s*(?:import\s+[^;]|export\s+(?:default|const|function|class|\{))/.test(code)) {
      throw new Error("preload output is not CommonJS: " + sourceFile);
    }
  }
  await mkdir(dirname(targetFile), { recursive: true });
  await writeFile(targetFile, code + "\n", "utf8");
  return { sourceFile, targetFile, bytes: Buffer.byteLength(code, "utf8") };
}

async function emitTree(tree, extension) {
  const base = join(srcDir, tree);
  const results = [];
  for (const file of await listFiles(base)) {
    if (!file.endsWith(".ts")) continue;
    const rel = relative(base, file).replace(/\.ts$/, "." + extension);
    results.push(await emit(file, join(outDir, tree, rel)));
  }
  return results;
}

async function copyStatic(fromRelative, toRelative) {
  const from = join(root, fromRelative);
  const to = join(outDir, toRelative);
  await mkdir(dirname(to), { recursive: true });
  await cp(from, to, { recursive: true, force: true });
}

async function buildPointerHelper() {
  if (process.platform !== "win32") return null;
  const windows = process.env.WINDIR || "C:\\Windows";
  const candidates = [
    join(windows, "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe"),
    join(windows, "Microsoft.NET", "Framework", "v4.0.30319", "csc.exe"),
  ];
  const compiler = candidates.find((candidate) => existsSync(candidate));
  if (!compiler) {
    console.warn("csc.exe not found; region capture will use the overlay fallback");
    return null;
  }
  const target = join(outDir, "bin", "dh-pointer.exe");
  await mkdir(dirname(target), { recursive: true });
  const result = spawnSync(
    compiler,
    ["/nologo", "/target:exe", "/optimize+", "/out:" + target, join(root, "tools", "pointer-helper.cs")],
    { encoding: "utf8", windowsHide: true },
  );
  if (result.status !== 0) {
    throw new Error("pointer helper compilation failed: " + (result.stderr || result.stdout || "unknown error"));
  }
  return target;
}

async function main() {
  console.log("building " + outDir);
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });

  const emitted = [];
  emitted.push(...(await emitTree("shared", "mjs")));
  emitted.push(...(await emitTree("main", "mjs")));
  emitted.push(await emit(join(srcDir, "preload", "index.ts"), join(outDir, "preload", "index.cjs"), { commonjs: true }));
  emitted.push(await emit(join(srcDir, "renderer", "renderer.ts"), join(outDir, "renderer", "renderer.js")));
  emitted.push(await emit(join(srcDir, "renderer", "region.ts"), join(outDir, "renderer", "region.js")));

  for (const name of ["index.html", "styles.css", "region.html", "region.css"]) {
    await copyStatic(join("src", "renderer", name), join("renderer", name));
  }
  const icon = await generateIcon(join(root, "assets", "icon.png"));
  await copyStatic(join("assets", "icon.png"), join("assets", "icon.png"));
  const pointerHelper = await buildPointerHelper();

  const sourcePackage = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  const appPackage = {
    name: sourcePackage.name,
    productName: "Desktophelper",
    version: sourcePackage.version,
    private: true,
    description: sourcePackage.description,
    type: "module",
    main: "main/index.mjs",
  };
  await writeFile(join(outDir, "package.json"), JSON.stringify(appPackage, null, 2) + "\n", "utf8");

  const summary = {
    builtAt: new Date().toISOString(),
    files: emitted.length,
    bytes: emitted.reduce((sum, item) => sum + item.bytes, 0),
    icon: icon.bytes,
    pointerHelper: pointerHelper ? relative(outDir, pointerHelper) : null,
    node: process.version,
  };
  await writeFile(join(outDir, "build-info.json"), JSON.stringify(summary, null, 2) + "\n", "utf8");
  console.log("build complete: " + emitted.length + " modules, " + summary.bytes + " bytes");
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exitCode = 1;
});
