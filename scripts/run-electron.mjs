import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { deployApp, executable, workspace } from "./deploy.mjs";

async function main() {
  await deployApp();
  const dataRoot = join(workspace, "work", "run-data");
  const env = {
    ...process.env,
    APPDATA: join(dataRoot, "appdata"),
    LOCALAPPDATA: join(dataRoot, "localappdata"),
    DH_DATA_DIR: join(dataRoot, "userdata"),
  };
  await Promise.all([
    mkdir(env.APPDATA, { recursive: true }),
    mkdir(env.LOCALAPPDATA, { recursive: true }),
    mkdir(env.DH_DATA_DIR, { recursive: true }),
  ]);

  const child = spawn(executable, process.argv.slice(2), {
    env,
    stdio: "inherit",
    windowsHide: false,
  });
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    if (child.exitCode === null && child.signalCode === null) child.kill();
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  const result = await new Promise((resolve) => {
    child.once("error", (error) => resolve({ code: 1, error }));
    child.once("exit", (code, signal) => resolve({ code: code ?? (signal ? 1 : 0), signal }));
  });
  if (result.error) {
    console.error("failed to start " + executable + ": " + result.error.message);
    process.exitCode = 1;
    return;
  }
  process.exitCode = result.code;
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exitCode = 1;
});
