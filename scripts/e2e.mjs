import { spawn, spawnSync } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { deployApp, executable, root, runtimeRoot, workspace } from "./deploy.mjs";

function fail(message) {
  throw new Error(message);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

function readDisplayAffinity(hwnd) {
  const script = [
    "$sig = '[DllImport(\"user32.dll\")] public static extern bool GetWindowDisplayAffinity(IntPtr hWnd, out uint pdwAffinity);'",
    "$type = Add-Type -MemberDefinition $sig -Name Win -Namespace Native -PassThru",
    "$affinity = 0",
    "$ok = $type::GetWindowDisplayAffinity([IntPtr]::new(" + hwnd + "), [ref]$affinity)",
    'if (-not $ok) { throw "GetWindowDisplayAffinity failed" }',
    "$affinity",
  ].join("\n");
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    fail("GetWindowDisplayAffinity query failed: " + (result.stderr || result.stdout));
  }
  return Number.parseInt(result.stdout.trim(), 10);
}

function readExtendedStyle(hwnd) {
  const script = [
    "$sig = '[DllImport(\"user32.dll\", SetLastError=true)] public static extern int GetWindowLong(IntPtr hWnd, int nIndex);'",
    "$type = Add-Type -MemberDefinition $sig -Name WinStyle -Namespace Native -PassThru",
    "$style = $type::GetWindowLong([IntPtr]::new(" + hwnd + "), -20)",
    "$style",
  ].join("\n");
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    fail("GetWindowLong query failed: " + (result.stderr || result.stdout));
  }
  return Number.parseInt(result.stdout.trim(), 10);
}

function readForegroundWindow() {
  const script = [
    "$sig = '[DllImport(\"user32.dll\")] public static extern IntPtr GetForegroundWindow();'",
    "$type = Add-Type -MemberDefinition $sig -Name WinForeground -Namespace Native -PassThru",
    "$type::GetForegroundWindow().ToInt64()",
  ].join("\n");
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    fail("GetForegroundWindow query failed: " + (result.stderr || result.stdout));
  }
  return Number.parseInt(result.stdout.trim(), 10);
}

function runPowerShell(script) {
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    fail("PowerShell probe failed: " + (result.stderr || result.stdout));
  }
  return result.stdout.trim();
}

function readWindowMetrics(hwnd) {
  const script = [
    "$sig = @'",
    "using System;",
    "using System.Runtime.InteropServices;",
    "public class WinMetrics {",
    "  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }",
    "  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }",
    '  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();',
    '  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);',
    '  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr hWnd, ref POINT point);',
    '  [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr hWnd);',
    "}",
    "'@",
    "Add-Type -TypeDefinition $sig",
    "[WinMetrics]::SetProcessDPIAware() | Out-Null",
    "$rect = New-Object WinMetrics+RECT",
    "$point = New-Object WinMetrics+POINT",
    "$handle = [IntPtr]::new(" + hwnd + ")",
    "if (-not [WinMetrics]::GetWindowRect($handle, [ref]$rect)) { throw 'GetWindowRect failed' }",
    "if (-not [WinMetrics]::ClientToScreen($handle, [ref]$point)) { throw 'ClientToScreen failed' }",
    "$dpi = [WinMetrics]::GetDpiForWindow($handle)",
    '"{0},{1},{2},{3},{4},{5},{6}" -f $rect.Left, $rect.Top, $rect.Right, $rect.Bottom, $point.X, $point.Y, $dpi',
  ].join("\n");
  const values = runPowerShell(script).split(",").map((value) => Number.parseInt(value, 10));
  const [left, top, right, bottom, clientX, clientY, dpi] = values;
  if (!values.every((value) => Number.isFinite(value))) {
    fail("unreadable window metrics: " + values.join(","));
  }
  return { left, top, right, bottom, clientX, clientY, dpi, scale: dpi / 96 };
}

function focusWindow(hwnd) {
  const script = [
    "$sig = @'",
    "using System;",
    "using System.Runtime.InteropServices;",
    "public class WinFocus {",
    '  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();',
    '  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);',
    '  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();',
    '  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool attach);',
    '  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);',
    '  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);',
    '  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int cmd);',
    "  public static bool Activate(IntPtr hWnd) {",
    "    uint pid;",
    "    uint foregroundThread = GetWindowThreadProcessId(GetForegroundWindow(), out pid);",
    "    uint currentThread = GetCurrentThreadId();",
    "    bool attached = foregroundThread != 0 && AttachThreadInput(currentThread, foregroundThread, true);",
    "    ShowWindow(hWnd, 9);",
    "    BringWindowToTop(hWnd);",
    "    bool ok = SetForegroundWindow(hWnd);",
    "    if (attached) AttachThreadInput(currentThread, foregroundThread, false);",
    "    return ok;",
    "  }",
    "}",
    "'@",
    "Add-Type -TypeDefinition $sig",
    "[WinFocus]::Activate([IntPtr]::new(" + hwnd + ")) | Out-Null",
    "Start-Sleep -Milliseconds 240",
    "[WinFocus]::GetForegroundWindow().ToInt64()",
  ].join("\n");
  return Number.parseInt(runPowerShell(script), 10);
}

function dragWithRealMouse(hwnd, x1, y1, x2, y2) {
  const script = [
    '$sig = @"',
    "using System;",
    "using System.Runtime.InteropServices;",
    "public class WinMouse {",
    '  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }',
    '  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }',
    '  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();',
    '  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);',
    '  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);',
    '  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);',
    '  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT point);',
    '  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr hWnd, int index);',
    "  public static IntPtr Target;",
    '  public static string Log = "";',
    "  public static void Record(int step) {",
    "    RECT rect; GetWindowRect(Target, out rect);",
    '    Log += step + "=" + rect.Left + "," + rect.Top + "," + rect.Right + "," + rect.Bottom + " [";',
    "    POINT point; GetCursorPos(out point);",
    "    IntPtr under = WindowFromPoint(point);",
    '    Log += "cursor=" + point.X + "," + point.Y + " under=" + under.ToInt64() + " ex=0x" + GetWindowLong(Target, -20).ToString("X8") + "];";',
    "  }",
    '  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT point);',
    "  public static void Drag(int startX, int startY, int endX, int endY) {",
    "    SetCursorPos(startX, startY);",
    "    System.Threading.Thread.Sleep(200);",
    "    Record(-2);",
    "    mouse_event(0x0002, 0, 0, 0, UIntPtr.Zero);",
    "    System.Threading.Thread.Sleep(140);",
    "    Record(-1);",
    "    for (int step = 1; step <= 12; step += 1) {",
    "      SetCursorPos(startX + (endX - startX) * step / 12, startY + (endY - startY) * step / 12);",
    "      System.Threading.Thread.Sleep(25);",
    "      Record(step);",
    "    }",
    "    System.Threading.Thread.Sleep(120);",
    "    mouse_event(0x0004, 0, 0, 0, UIntPtr.Zero);",
    "    System.Threading.Thread.Sleep(320);",
    "    Record(99);",
    "  }",
    "}",
    '"@',
    "Add-Type -TypeDefinition $sig",
    "[WinMouse]::SetProcessDPIAware() | Out-Null",
    "[WinMouse]::Target = [IntPtr]::new(" + hwnd + ")",
    "[WinMouse]::Drag(" + x1 + ", " + y1 + ", " + x2 + ", " + y2 + ")",
    "[WinMouse]::Log",
  ].join("\n");
  return runPowerShell(script);
}
async function launchFocusAnchor(file) {
  const script = [
    "Add-Type -AssemblyName System.Windows.Forms",
    "$form = New-Object System.Windows.Forms.Form",
    "$form.Text = 'DH Focus Anchor'",
    "$form.StartPosition = 'Manual'",
    "$form.Left = 32",
    "$form.Top = 32",
    "$form.Width = 340",
    "$form.Height = 220",
    "$form.Show()",
    "[System.IO.File]::WriteAllText('" + file.replace(/\\/g, "/") + "', $form.Handle.ToInt64().ToString())",
    "[System.Windows.Forms.Application]::Run()",
  ].join("; ");
  const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-STA", "-Command", script], {
    stdio: "ignore",
    windowsHide: true,
  });
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const text = await readFile(file, "utf8").catch(() => "");
    if (text.trim()) return { child, hwnd: Number.parseInt(text.trim(), 10) };
    if (child.exitCode !== null) break;
    await delay(100);
  }
  child.kill();
  fail("focus anchor window did not start");
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toneWav(seconds = 3, sampleRate = 16000, amplitude = 0.3) {
  const samples = Math.round(seconds * sampleRate);
  const buffer = Buffer.alloc(44 + samples * 2);
  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + samples * 2, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(samples * 2, 40);
  for (let index = 0; index < samples; index += 1) {
    const value = Math.sin((2 * Math.PI * 440 * index) / sampleRate) * amplitude;
    buffer.writeInt16LE(Math.round(value * 32767), 44 + index * 2);
  }
  return buffer;
}

async function waitForMarker(file, child, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const text = await readFile(file, "utf8").catch(() => "");
    if (text.includes("DH_E2E_READY")) return text;
    if (child.exitCode !== null || child.signalCode !== null) return text;
    await delay(120);
  }
  return await readFile(file, "utf8").catch(() => "");
}

async function waitForExit(child, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      reject(new Error("Electron did not exit within " + timeoutMs + "ms"));
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

async function scanBuild() {
  const outDir = join(root, "out");
  const files = [];
  const walk = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const full = join(directory, entry.name);
      if (entry.isDirectory()) await walk(full);
      else files.push(full);
    }
  };
  await walk(outDir);
  const source = (await Promise.all(
    files
      .filter((file) => /\.(mjs|js|cjs|html)$/.test(file))
      .map(async (file) => await readFile(file, "utf8")),
  )).join("\n");
  for (const forbidden of ['"auth.', "auth.login", "auth.refresh", "authStore", "auth-store"]) {
    assert(!source.includes(forbidden), "forbidden auth artifact in build: " + forbidden);
  }
  assert(!source.includes('data-testid="login"'), "login markup found in build");
  return files.length;
}

async function main() {
  console.log("== building ==");
  const build = spawnSync(process.execPath, [join(root, "scripts", "build.mjs")], { stdio: "inherit" });
  assert(build.status === 0, "build failed with exit code " + build.status);

  console.log("== deploying to test runtime ==");
  await deployApp();
  const scanned = await scanBuild();
  console.log("scanned " + scanned + " build files: no auth channel or login page");

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const runDir = join(workspace, "work", "e2e-runs", "run-" + stamp);
  const marker = join(runDir, "marker.txt");
  const shot = join(runDir, "overlay.png");
  const minShot = join(runDir, "overlay-min.png");
  const voiceMinShot = join(runDir, "overlay-min-voice.png");
  const processLog = join(runDir, "process.log");
  const dataDir = join(runDir, "userdata");
  const appData = join(runDir, "appdata");
  const localAppData = join(runDir, "localappdata");
  await Promise.all([
    mkdir(runDir, { recursive: true }),
    mkdir(dataDir, { recursive: true }),
    mkdir(appData, { recursive: true }),
    mkdir(localAppData, { recursive: true }),
  ]);
  const fakeMicPath = join(runDir, "fake-mic.wav");
  if (process.env.DH_E2E_VOICE === "1") {
    await writeFile(
      join(dataDir, "settings.json"),
      JSON.stringify({ version: 1, transcription: { provider: "mock" } }, null, 2) + "\n",
      "utf8",
    );
    await writeFile(fakeMicPath, toneWav());
  }

  const env = {
    ...process.env,
    DH_E2E: "1",
    DH_E2E_OUT: marker,
    DH_E2E_SHOT: shot,
    DH_E2E_MIN_SHOT: minShot,
    DH_E2E_VOICE_MIN_SHOT: process.env.DH_E2E_VOICE === "1" ? voiceMinShot : "",
    DH_E2E_MOCK_DELAY_MS: "120",
    DH_E2E_QUIT: "0",
    DH_E2E_REGION_RECT: "200,200,600,500",
    DH_DATA_DIR: dataDir,
    APPDATA: appData,
    LOCALAPPDATA: localAppData,
  };

  console.log("== launching " + executable + " ==");
  const launchArgs = ["--disable-gpu"];
  if (process.env.DH_E2E_VOICE === "1") {
    launchArgs.push(
      "--use-fake-device-for-media-stream",
      "--use-file-for-fake-audio-capture=" + fakeMicPath,
      "--use-fake-ui-for-media-stream",
      "--autoplay-policy=no-user-gesture-required",
    );
  }
  const child = spawn(executable, launchArgs, {
    env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: false,
  });
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    output += chunk.toString();
  });

  let markerText = "";
  let exit = null;
  try {
    markerText = await waitForMarker(marker, child, 75000);
    if (!markerText) {
      console.error("--- process output ---\n" + output);
      fail("E2E marker was not written");
    }
    assert(markerText.includes("DH_E2E_READY"), "marker is missing DH_E2E_READY");

    const checkLine = markerText.split(/\r?\n/).find((line) => line.startsWith("DH_E2E_CHECK "));
    assert(checkLine, "marker is missing DH_E2E_CHECK");
    const probe = JSON.parse(checkLine.slice("DH_E2E_CHECK ".length));
    assert(probe.hasAppRoot === true, "renderer app root missing");
    assert(probe.hasLogin === false, "login UI must not exist");
    assert(probe.nodeRequire === "undefined", "renderer has access to require");
    assert(probe.nodeProcess === "undefined", "renderer has access to process");
    assert(probe.hasApi === true, "preload API missing");
    assert(Array.isArray(probe.apiKeys) && probe.apiKeys.includes("invoke"), "preload invoke missing");
    assert(probe.apiKeys.includes("on"), "preload event API missing");
    assert(typeof probe.url === "string" && probe.url.startsWith("app://desktophelper/"), "unexpected renderer URL");
    assert(probe.hasAutoAnswerControl === false, "auto-answer must not be shown as a configuration control");
    assert(probe.hasClickThroughControl === false, "click-through must not be shown as a configuration control");
    assert(probe.hasClickThroughHotkeyControl === false, "click-through hotkey control must not be shown");
    assert(probe.hasSessionTitle === false, "the centered session title must not be shown");
    assert(Array.isArray(probe.navTabs) && probe.navTabs.length === 3, "navigation must expose exactly three entries");
    assert(probe.navTabs.join(",") === "shots,voice,more", "navigation entries must be shots, voice and more");
    assert(Array.isArray(probe.statusLights) && probe.statusLights.length === 3, "status strip must expose exactly three lights");
    assert(probe.footerShortcuts === 3, "footer must expose exactly three shortcuts");
    assert(
      Math.abs(probe.windowOpacity - probe.expectedOpacity) < 0.01,
      "overlay opacity must match the saved setting on startup: " +
        JSON.stringify({ actual: probe.windowOpacity, expected: probe.expectedOpacity }),
    );

    const hotkeyError = markerText.split(/\r?\n/).find((line) => line.startsWith("DH_E2E_HOTKEYS_ERROR "));
    assert(!hotkeyError, "hotkey probe failed: " + (hotkeyError || ""));
    const hotkeyLine = markerText.split(/\r?\n/).find((line) => line.startsWith("DH_E2E_HOTKEYS "));
    assert(hotkeyLine, "marker is missing DH_E2E_HOTKEYS");
    const hotkeys = JSON.parse(hotkeyLine.slice("DH_E2E_HOTKEYS ".length));
    assert(Array.isArray(hotkeys.registrations) && hotkeys.registrations.length >= 20, "too few hotkey registrations");
    const regionHotkey = hotkeys.registrations.find((entry) => entry.action === "captureRegion");
    assert(regionHotkey, "region capture hotkey was not registered");
    assert(regionHotkey.registered === true && regionHotkey.active === true, "region capture hotkey is inactive");
    assert(
      hotkeys.platform !== "win32" || regionHotkey.accelerator === "Control+H",
      "region capture hotkey did not resolve to Control+H: " + regionHotkey.accelerator,
    );
    const emergencyHotkey = hotkeys.registrations.find((entry) => entry.action === "emergencyHide");
    assert(emergencyHotkey, "emergency hide hotkey was not registered");
    assert(
      emergencyHotkey.registered === true && emergencyHotkey.active === true,
      "emergency hide hotkey is inactive",
    );
    assert(
      hotkeys.platform !== "win32" || emergencyHotkey.accelerator === "Control+Shift+H",
      "emergency hide hotkey did not resolve to Control+Shift+H: " + emergencyHotkey.accelerator,
    );
    const inactive = hotkeys.registrations.filter((entry) => entry.active !== true);
    assert(inactive.length === 0, "inactive hotkeys: " + inactive.map((entry) => entry.action).join(", "));

    const captureLine = markerText.split(/\r?\n/).find((line) => line.startsWith("DH_E2E_CAPTURE "));
    assert(captureLine, "marker is missing DH_E2E_CAPTURE");
    const capture = JSON.parse(captureLine.slice("DH_E2E_CAPTURE ".length));
    assert(capture.enabled === true, "screen share protection must default to on");

    const groupsError = markerText.split(/\r?\n/).find((line) => line.startsWith("DH_E2E_GROUPS_ERROR "));
    assert(!groupsError, "screenshot group probe failed: " + (groupsError || ""));
    const groupsLine = markerText.split(/\r?\n/).find((line) => line.startsWith("DH_E2E_GROUPS "));
    assert(groupsLine, "marker is missing DH_E2E_GROUPS");
    const groups = JSON.parse(groupsLine.slice("DH_E2E_GROUPS ".length));
    assert(groups.visible === true, "screenshot tab did not become active");
    assert(groups.groups >= 1, "screenshot group card was not rendered");
    assert(groups.title.startsWith("第 1 组"), "unexpected group title: " + groups.title);
    assert(groups.thumbs >= 1, "group thumbnail missing");
    assert(groups.thumbDeletes === groups.thumbs, "every screenshot thumbnail needs a delete button");
    assert(groups.firstDeleteDisabled === false, "screenshot delete button should be enabled while collecting");
    assert(groups.deleteActionWorked === true, "clicking a thumbnail delete button did not remove the screenshot group");
    assert(groups.mainLabel === "解题", "unexpected group main action: " + groups.mainLabel);
    assert(groups.menuLabel === "⋯", "group menu trigger missing");
    assert(groups.menuOpen === true, "group menu did not open");
    for (const item of ["补图", "只提取题面", "结束本组", "复制解答", "删除本组"]) {
      assert(groups.menuItems.includes(item), "group menu is missing: " + item);
    }

    const regionError = markerText.split(/\r?\n/).find((line) => line.startsWith("DH_E2E_REGION_ERROR "));
    assert(!regionError, "region screenshot probe failed: " + (regionError || ""));
    const regionLine = markerText.split(/\r?\n/).find((line) => line.startsWith("DH_E2E_REGION "));
    assert(regionLine, "marker is missing DH_E2E_REGION");
    const region = JSON.parse(regionLine.slice("DH_E2E_REGION ".length));
    assert(region.opened === true, "region selector did not open");
    if (process.platform === "win32") {
      assert(region.mode === "pointer", "region screenshot used a full-screen selector window: " + region.mode);
    }
    assert(region.count === region.before + 1, "region screenshot was not saved");
    assert(region.meta?.mode === "region", "region screenshot mode mismatch");
    const regionScale = Number(region.scaleFactor) > 0 ? Number(region.scaleFactor) : 1;
    const expectedWidth = Math.round(400 * regionScale);
    const expectedHeight = Math.round(300 * regionScale);
    assert(
      Math.abs(region.meta.width - expectedWidth) <= 2,
      "unexpected region width: " + region.meta.width + " (expected " + expectedWidth + " at " + regionScale + "x)",
    );
    assert(
      Math.abs(region.meta.height - expectedHeight) <= 2,
      "unexpected region height: " + region.meta.height + " (expected " + expectedHeight + " at " + regionScale + "x)",
    );
    const regionPng = await readFile(join(dataDir, "screenshots", region.meta.file));
    assert(regionPng.subarray(0, 8).toString("hex") === "89504e470d0a1a0a", "region screenshot is not a PNG");
    assert(Math.abs(regionPng.readUInt32BE(16) - expectedWidth) <= 2, "region PNG width mismatch");
    assert(Math.abs(regionPng.readUInt32BE(20) - expectedHeight) <= 2, "region PNG height mismatch");
    const groupNavError = markerText.split(/\r?\n/).find((line) => line.startsWith("DH_E2E_GROUPNAV_ERROR "));
    assert(!groupNavError, "group navigation probe failed: " + (groupNavError || ""));
    const groupNavLine = markerText.split(/\r?\n/).find((line) => line.startsWith("DH_E2E_GROUPNAV "));
    assert(groupNavLine, "marker is missing DH_E2E_GROUPNAV");
    const groupNav = JSON.parse(groupNavLine.slice("DH_E2E_GROUPNAV ".length));
    assert(!groupNav.error, "group navigation probe error: " + (groupNav.error || ""));
    assert(groupNav.groups === 2, "group navigation probe did not create two groups: " + groupNav.groups);
    assert(groupNav.before.startsWith("第 2 组"), "new group did not become current: " + groupNav.before);
    assert(groupNav.after.startsWith("第 1 组"), "left swipe did not open the older group: " + groupNav.after);
    assert(groupNav.restored.startsWith("第 2 组"), "previous-group control did not return to the newer group");
    assert(
      groupNav.afterArrowDrag.startsWith("第 1 组"),
      "swipe starting on the group arrow did not open the older group: " + groupNav.afterArrowDrag,
    );
    assert(groupNav.arrowClickSeen === false, "a swipe released over the group arrow also fired its click");
    assert(
      groupNav.restoredAfterArrowDrag.startsWith("第 2 组"),
      "returning to the newer group after an arrow swipe failed: " + groupNav.restoredAfterArrowDrag,
    );
    assert(
      groupNav.beforeArrowClick.startsWith("第 2 组") && groupNav.afterArrowClick.startsWith("第 1 组"),
      "group arrow click no longer works after swiping: " +
        JSON.stringify({ before: groupNav.beforeArrowClick, after: groupNav.afterArrowClick }),
    );
    assert(groupNav.interactive === "grab", "group title is not exposed as draggable: " + groupNav.interactive);
    assert(
      typeof region.brightness === "number" && region.brightness > 12,
      "region screenshot looks like a black frame: brightness=" + region.brightness,
    );

    if (process.env.DH_E2E_VOICE === "1") {
      const voiceError = markerText.split(/\r?\n/).find((line) => line.startsWith("DH_E2E_VOICE_ERROR "));
      assert(!voiceError, "voice probe failed: " + (voiceError || ""));
      const voiceLine = markerText.split(/\r?\n/).find((line) => line.startsWith("DH_E2E_VOICE_PROBE "));
      assert(voiceLine, "marker is missing DH_E2E_VOICE_PROBE");
      const voice = JSON.parse(voiceLine.slice("DH_E2E_VOICE_PROBE ".length));
      assert(!voice.error, "voice probe error: " + voice.error);
      assert(voice.hintDuring.includes("麦克风"), "microphone did not start: " + voice.hintDuring);
      assert(voice.hintAfter === "未收音", "microphone did not stop: " + voice.hintAfter);
      assert(voice.during?.className?.includes("recording"), "listen button is not red while recording");
      assert(voice.during?.pressed === "true", "listen button aria-pressed is not true while recording");
      assert(voice.after?.className?.includes("idle"), "listen button is not green when idle");
      assert(voice.after?.pressed === "false", "listen button aria-pressed is not false when idle");
      assert(voice.segments >= 1, "voice segment was not transcribed: " + voice.text);
      assert(voice.text.includes("演示转写"), "unexpected voice transcript: " + voice.text);
      assert(voice.voiceVisible === true, "voice page is not visible after switching tabs");
      assert(voice.shotsHidden === true, "screenshot page is still visible on the voice tab");
      assert(voice.voiceOverflowX <= 1, "voice page overflows horizontally: " + voice.voiceOverflowX);
      assert(voice.voiceLiveWidth >= 250, "voice transcript pane collapsed: " + voice.voiceLiveWidth);
      assert(voice.voiceSideCollapsed === false, "voice answer history should stay visible in compact mode");
      assert(voice.voiceSideWidth >= 300, "voice answer sheet is too narrow: " + voice.voiceSideWidth);
      assert(voice.voiceSegmentsHeight >= 80, "voice transcript list collapsed: " + voice.voiceSegmentsHeight);
      assert(voice.voiceAnswersVisible === true, "voice answer history pane is not visible");
      assert(voice.voiceAnswersWidth >= 300, "voice answer history pane collapsed: " + voice.voiceAnswersWidth);
      assert(voice.voiceAnswersHeight >= 100, "voice answer history has no room: " + voice.voiceAnswersHeight);
      assert(voice.voiceAnswerCount >= 1, "voice answer history did not render the generated answer");
      assert(voice.voiceAnswerText.includes("演示"), "unexpected voice answer text: " + voice.voiceAnswerText);
      assert(voice.voiceAskHeight >= 36, "voice ask form is not usable: " + voice.voiceAskHeight);
      if (process.platform === "win32") {
        assert(voice.systemTracks >= 1, "system audio loopback track missing: " + (voice.systemError || "none"));
      }
      console.log("voice pipeline: " + JSON.stringify(voice));
    }

    if (capture.platform === "win32") {
      assert(capture.hwnd, "native window handle missing from capture probe");
      const affinity = readDisplayAffinity(capture.hwnd);
      assert(affinity === 0x11, "expected WDA_EXCLUDEFROMCAPTURE (0x11), got " + affinity);
      capture.affinity = affinity;
      const extendedStyle = readExtendedStyle(capture.hwnd);
      assert(
        (extendedStyle & 0x08000000) !== 0,
        "overlay is missing WS_EX_NOACTIVATE (extended style 0x" + extendedStyle.toString(16) + ")",
      );
      assert(
        (extendedStyle & 0x00000080) !== 0,
        "overlay is missing WS_EX_TOOLWINDOW and would appear in the taskbar (extended style 0x" +
          extendedStyle.toString(16) +
          ")",
      );
      const foreground = readForegroundWindow();
      assert(
        foreground !== Number(capture.hwnd),
        "overlay became the foreground window and would trigger exam focus detection",
      );
      capture.extendedStyle = extendedStyle;
      capture.foreground = foreground;
    }

    if (capture.platform === "win32") {
      const hwnd = Number(capture.hwnd);
      const anchorFile = join(runDir, "focus-anchor.txt");
      const anchor = await launchFocusAnchor(anchorFile);
      try {
        assert(anchor.hwnd > 0, "focus anchor window handle missing");
        const focused = focusWindow(anchor.hwnd);
        assert(focused === anchor.hwnd, "focus anchor did not become the foreground window");
        await delay(300);
        const before = readWindowMetrics(hwnd);
        let after = before;
        let moved = false;
        for (let attempt = 0; attempt < 3 && !moved; attempt += 1) {
          const current = readWindowMetrics(hwnd);
          const startX = Math.round(current.clientX + 96 * current.scale);
          const startY = Math.round(current.clientY + 24 * current.scale);
          const endX = startX + Math.round(40 * current.scale);
          const endY = startY + Math.round(26 * current.scale);
          dragWithRealMouse(hwnd, startX, startY, endX, endY);
          await delay(420);
          after = readWindowMetrics(hwnd);
          moved =
            Math.abs(after.left - before.left) >= 10 || Math.abs(after.top - before.top) >= 10;
        }
        assert(
          moved,
          "real mouse drag did not reach the overlay: " + JSON.stringify({ before, after }),
        );
        assert(
          Math.abs(after.right - after.left - (before.right - before.left)) <= 1 &&
            Math.abs(after.bottom - after.top - (before.bottom - before.top)) <= 1,
          "dragging the overlay changed its size: " + JSON.stringify({ before, after }),
        );
        const foregroundAfterDrag = readForegroundWindow();
        assert(
          foregroundAfterDrag === anchor.hwnd,
          "dragging the overlay stole focus from the foreground window",
        );
        console.log(
          "native focus isolation: " +
            JSON.stringify({ anchorHwnd: anchor.hwnd, before, after, foregroundAfterDrag }),
        );
      } finally {
        anchor.child.kill();
      }
    }

    const png = await readFile(shot).catch(() => null);
    assert(png && png.length > 1000, "screenshot was not captured");
    const signature = png.subarray(0, 8).toString("hex");
    assert(signature === "89504e470d0a1a0a", "screenshot is not a PNG");
    const width = png.readUInt32BE(16);
    const height = png.readUInt32BE(20);
    assert(width >= 200 && height >= 200, "screenshot dimensions are too small: " + width + "x" + height);

    const minLayoutError = markerText.split(/\r?\n/).find((line) => line.startsWith("DH_E2E_MINLAYOUT_ERROR "));
    assert(!minLayoutError, "minimum-size layout probe failed: " + (minLayoutError || ""));
    const minLayoutLine = markerText.split(/\r?\n/).find((line) => line.startsWith("DH_E2E_MINLAYOUT "));
    assert(minLayoutLine, "marker is missing DH_E2E_MINLAYOUT");
    const minLayout = JSON.parse(minLayoutLine.slice("DH_E2E_MINLAYOUT ".length));
    const compact = minLayout.compact;
    assert(compact.innerWidth >= 340 && compact.innerWidth <= 500, "compact width was not applied: " + compact.innerWidth);
    assert(compact.overflowX <= 1, "compact layout overflows horizontally: " + compact.overflowX);
    assert(compact.compactClass === true, "default layout is not the compact single column");
    assert(compact.navVisible === true && compact.navButtons === 3, "compact nav strip is incomplete");
    assert(compact.workbenchVisible === true, "workbench is not visible in compact layout");
    assert(compact.workbenchHeight >= 300, "compact workbench is too short: " + compact.workbenchHeight);
    assert(compact.railWidth >= 300, "compact screenshot strip is too narrow: " + compact.railWidth);
    assert(compact.answerWidth >= 300, "compact answer pane is too narrow: " + compact.answerWidth);
    assert(compact.railWidth <= compact.innerWidth, "screenshot history strip widened the window layout: " + compact.railWidth);
    assert(compact.answerWidth <= compact.innerWidth, "answer pane widened the window layout: " + compact.answerWidth);
    assert(compact.stacked === true, "compact screenshot page is not a single column");
    assert(minLayout.voiceBefore.liveVisible === true, "compact voice page is not visible");
    assert(minLayout.voiceBefore.sideVisible === true, "compact voice answer history must stay visible");
    assert(minLayout.voiceBefore.liveWidth >= 300, "compact voice transcript is too narrow");
    assert(minLayout.voiceBefore.segmentsHeight >= 80, "compact transcript list collapsed");
    assert(minLayout.voiceBefore.askHeight >= 36, "compact ask box collapsed");
    assert(minLayout.voiceSheet.visible === true, "voice answer sheet did not open");
    assert(minLayout.voiceSheet.width >= 300, "voice answer sheet is too narrow: " + minLayout.voiceSheet.width);
    assert(minLayout.voiceSheet.height >= 100, "voice answer sheet is too short: " + minLayout.voiceSheet.height);
    assert(minLayout.voiceSheet.overflowX <= 1, "voice answer sheet overflows horizontally");
    const expanded = minLayout.expanded;
    assert(expanded.innerWidth >= 700, "expanded width was not applied: " + expanded.innerWidth);
    assert(expanded.innerWidth <= 990, "expanded width is too large: " + expanded.innerWidth);
    assert(expanded.overflowX <= 1, "expanded layout overflows horizontally: " + expanded.overflowX);
    assert(expanded.compactClass === false, "expanded layout kept the compact class");
    assert(expanded.navVisible === true, "nav strip disappeared in expanded layout");
    assert(expanded.railWidth >= 200, "expanded screenshot rail collapsed: " + expanded.railWidth);
    assert(expanded.answerWidth >= 350, "expanded answer pane collapsed: " + expanded.answerWidth);
    assert(expanded.sideBySide === true, "expanded screenshot page did not become two columns");
    assert(minLayout.expandedVoice.sideWidth >= 240, "expanded voice answer history collapsed");
    assert(minLayout.expandedVoice.sideBySide === true, "expanded voice page did not become two columns");
    assert(minLayout.collapsed.innerWidth <= 500, "layout did not return to compact width: " + minLayout.collapsed.innerWidth);
    assert(minLayout.collapsed.compactClass === true, "layout did not return to compact mode");
    assert(minLayout.collapsed.overflowX <= 1, "collapsed layout overflows horizontally");
    assert(
      Math.abs(minLayout.windowOpacity - probe.expectedOpacity) < 0.01,
      "layout changes must not alter overlay opacity: " +
        JSON.stringify({ actual: minLayout.windowOpacity, expected: probe.expectedOpacity }),
    );
    assert(minLayout.compact.navButtons === 3, "compact navigation must expose exactly three entries");
    assert(minLayout.compact.statusLights.length === 3, "compact status strip must expose exactly three lights");
    assert(minLayout.compact.footerButtons === 3, "compact footer shortcuts must stay visible");
    assert(minLayout.compact.shotActions.length === 1, "compact screenshot page must expose one primary action");
    assert(minLayout.settingsAuto.visible === true, "settings page did not open");
    assert(minLayout.settingsAuto.hotkeySummary.includes("无冲突"), "hotkey conflict center did not report a clean state");
    assert(minLayout.settingsAuto.compactClass === false, "settings page did not expand the workspace");
    assert(minLayout.settingsAuto.innerWidth >= 700, "settings page did not widen the window: " + minLayout.settingsAuto.innerWidth);
    assert(minLayout.knowledgeAuto.visible === true, "knowledge page did not open");
    assert(minLayout.knowledgeAuto.compactClass === true, "knowledge page must keep the compact single column");
    assert(minLayout.knowledgeAuto.innerWidth <= 500, "knowledge page must not widen the window: " + minLayout.knowledgeAuto.innerWidth);
    for (const [name, back] of [["settings", minLayout.settingsCollapsed], ["knowledge", minLayout.knowledgeCollapsed]]) {
      assert(back.compactClass === true, name + " page did not collapse back to single column");
      assert(back.innerWidth <= 500, name + " page kept the wide window: " + back.innerWidth);
    }
    assert(minLayout.voice.visible === true, "compact voice page is not visible");
    assert(minLayout.voice.sheetVisible === true, "compact voice answer sheet was not captured");
    const minPng = await readFile(minShot).catch(() => null);
    assert(minPng && minPng.length > 1000, "minimum-size screenshot was not captured");
    assert(minPng.subarray(0, 8).toString("hex") === "89504e470d0a1a0a", "minimum-size screenshot is not a PNG");
    if (process.env.DH_E2E_VOICE === "1") {
      const voicePng = await readFile(voiceMinShot).catch(() => null);
      assert(voicePng && voicePng.length > 1000, "minimum-size voice screenshot was not captured");
      assert(
        voicePng.subarray(0, 8).toString("hex") === "89504e470d0a1a0a",
        "minimum-size voice screenshot is not a PNG",
      );
    }

    const hitError = markerText.split(/\r?\n/).find((line) => line.startsWith("DH_E2E_HIT_ERROR "));
    assert(!hitError, "hit-region probe failed: " + (hitError || ""));
    const hitLine = markerText.split(/\r?\n/).find((line) => line.startsWith("DH_E2E_HIT "));
    assert(hitLine, "marker is missing DH_E2E_HIT");
    const hit = JSON.parse(hitLine.slice("DH_E2E_HIT ".length));
    assert(hit.regions > 0, "renderer did not publish hit regions");
    for (const control of ["solve", "groupSolve", "voiceTab", "moreTab"]) {
      assert(hit[control] === true, control + " is not covered by a click-through hit region");
    }

    const settingsHitError = markerText
      .split(/\r?\n/)
      .find((line) => line.startsWith("DH_E2E_SETTINGS_HIT_ERROR "));
    assert(!settingsHitError, "settings scroll hit probe failed: " + (settingsHitError || ""));
    const settingsHitLine = markerText
      .split(/\r?\n/)
      .find((line) => line.startsWith("DH_E2E_SETTINGS_HIT "));
    assert(settingsHitLine, "marker is missing DH_E2E_SETTINGS_HIT");
    const settingsHit = JSON.parse(settingsHitLine.slice("DH_E2E_SETTINGS_HIT ".length));
    assert(settingsHit.active === true, "settings tab did not open");
    assert(
      settingsHit.rect && settingsHit.rect.width > 0 && settingsHit.rect.height > 0,
      "settings scroll container has no measurable size",
    );
    assert(
      settingsHit.covered === true,
      "settings scroll area is not covered by a click-through hit region",
    );

    const solveError = markerText.split(/\r?\n/).find((line) => line.startsWith("DH_E2E_SOLVE_ERROR "));
    assert(!solveError, "solve/stop probe failed: " + (solveError || ""));
    const solveLine = markerText.split(/\r?\n/).find((line) => line.startsWith("DH_E2E_SOLVE "));
    assert(solveLine, "marker is missing DH_E2E_SOLVE");
    const solveProbe = JSON.parse(solveLine.slice("DH_E2E_SOLVE ".length));
    assert(solveProbe.before === "解题", "compact group is not ready to solve: " + solveProbe.before);
    assert(solveProbe.during === "停止", "solve action did not enter the answering state: " + solveProbe.during);
    assert(solveProbe.recovered === "解题", "stop did not restore the group to collecting: " + solveProbe.recovered);
    assert(
      solveProbe.finalStatus.includes("采集") || solveProbe.finalStatus.includes("收集"),
      "stopped group is not collecting: " + solveProbe.finalStatus,
    );
    assert(solveProbe.enabled === true, "stopped group controls stayed disabled");

    const historyError = markerText.split(/\r?\n/).find((line) => line.startsWith("DH_E2E_HISTORY_ERROR "));
    assert(!historyError, "group history probe failed: " + (historyError || ""));
    const historyLine = markerText.split(/\r?\n/).find((line) => line.startsWith("DH_E2E_HISTORY "));
    assert(historyLine, "marker is missing DH_E2E_HISTORY");
    const history = JSON.parse(historyLine.slice("DH_E2E_HISTORY ".length));
    assert(!history.error, "group history probe error: " + (history.error || ""));
    assert(history.count >= 3, "group history did not keep prior answers: " + history.count);
    assert(history.answers === history.count, "history list does not match stored answer ids");
    assert(history.summaries[0] === `第 ${history.count} 次`, "newest history entry is not first");
    assert(history.latestFirst === true, "newest history entry is not marked as latest");
    assert(history.openBefore === 1, "only the newest history entry should open by default");
    assert(history.openAfter === 2, "an older history entry did not expand");
    assert(
      history.selectedAfter === history.otherId,
      "clicking another group card did not select it: " +
        JSON.stringify({ selectedAfter: history.selectedAfter, otherId: history.otherId, panelTitle: history.panelTitle }),
    );
    assert(
      history.panelTitle.includes(`第 ${history.otherSeq} 组`),
      "answer panel did not follow the selected group: " + history.panelTitle,
    );
    assert(
      history.otherHistory === (history.otherStored > 1 ? history.otherStored : 0),
      "another group's answer panel does not match its own stored history: " +
        JSON.stringify({ otherHistory: history.otherHistory, otherStored: history.otherStored }),
    );
    assert(
      history.otherEmpty === (history.otherStored === 0),
      "group empty state does not match its stored answers: " +
        JSON.stringify({ otherEmpty: history.otherEmpty, otherStored: history.otherStored }),
    );
    assert(
      history.restored === history.count,
      "clicking back to a group lost its history: " + JSON.stringify({ restored: history.restored, count: history.count }),
    );
    assert(
      history.restoredSelected && history.restoredSelected !== history.otherId,
      "clicking back did not restore the original group selection",
    );

    const sessions = JSON.parse(await readFile(join(dataDir, "sessions.json"), "utf8"));
    const settings = JSON.parse(await readFile(join(dataDir, "settings.json"), "utf8"));
    assert(Array.isArray(sessions.sessions) && sessions.sessions.length >= 1, "session data was not persisted");
    assert(settings.version === 5, "settings version was not upgraded to 5");
    assert(settings.trigger.autoAnswer === true, "auto answer must default to on");
    assert(settings.overlay.clickThrough === true, "click-through must default to on");
    assert(settings.overlay.compact === true, "compact layout must default to on");

    console.log("== e2e passed ==");
    console.log("probe: " + JSON.stringify(probe));
    console.log("capture protection: " + JSON.stringify(capture));
    console.log("screenshot groups: " + JSON.stringify(groups));
    console.log("screenshot: " + shot + " (" + width + "x" + height + ", " + png.length + " bytes)");
    console.log("minimum layout: " + JSON.stringify(minLayout));
    console.log("minimum screenshot: " + minShot + " (" + minPng.length + " bytes)");
    console.log("data dir: " + dataDir);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    exit = await waitForExit(child, 15000).catch(() => ({ code: null, signal: "killed" }));
    await writeFile(processLog, output, "utf8");
  }
  console.log("process exit: " + JSON.stringify(exit));
}

main().catch((error) => {
  console.error("E2E FAILED: " + (error && error.message ? error.message : String(error)));
  process.exitCode = 1;
});
