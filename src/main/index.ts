import {
  app,
  BrowserWindow,
  clipboard,
  desktopCapturer,
  globalShortcut,
  ipcMain,
  Menu,
  nativeImage,
  nativeTheme,
  protocol,
  screen,
  session as electronSession,
  shell,
  Tray,
} from "electron";
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { dirname, extname, join, normalize, resolve, sep } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { AppError, ok, toIpcError } from "../shared/result.ts";
import type { Channel, EventName, PayloadOf } from "../shared/protocol.ts";
import { APP_HOST, APP_SCHEME, isChannel, payloadSchemas, validatePayload } from "../shared/protocol.ts";
import type { AppSettings, ScreenshotMeta } from "../shared/models.ts";
import { defaultSettings } from "../shared/models.ts";
import { overlayDragBounds, overlayHitZone, type OverlayHitRegion } from "../shared/overlay.ts";
import { isUsableRegion, type Point } from "../shared/region.ts";
import { toGlobalAccelerator } from "../shared/hotkeys.ts";
import { Logger } from "./logger.ts";
import {
  captureDisplay,
  clearPendingRegionCapture,
  getRegionPreview,
  rememberRegionCapture,
} from "./screenshots.ts";
import {
  parsePointerEvent,
  physicalPointToDip,
  regionOnDisplays,
  type MonitorInfo,
  type PointerEvent,
} from "./region-select.ts";
import { SecretsStore } from "./secrets.ts";
import { AppService, type HotkeyBridge, type OverlayBridge } from "./service.ts";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, "..");
const preloadPath = join(outDir, "preload", "index.cjs");
const isE2E = process.env.DH_E2E === "1";

app.setName("Desktophelper");
if (process.env.DH_DATA_DIR) {
  app.setPath("userData", resolve(process.env.DH_DATA_DIR));
} else if (!isE2E) {
  // Keep this rewrite isolated from the original app's %APPDATA%\Desktophelper.
  app.setPath("userData", join(app.getPath("appData"), "DesktophelperRewrite"));
}
// A stable AppUserModelID keeps the shell identity (icon, grouping, tray and
// jump list) consistent between dev runs and packaged builds.
if (process.platform === "win32") app.setAppUserModelId("com.desktophelper.overlay");

protocol.registerSchemesAsPrivileged([
  {
    scheme: APP_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
  },
]);

type AppState = {
  service: AppService;
  logger: Logger;
  overlay: BrowserWindow | null;
  tray: Tray | null;
  region: BrowserWindow | null;
  regionDisplayId: string | null;
  regionReadyResolve: (() => void) | null;
  regionRestoreOverlay: boolean;
  regionOpening: boolean;
  pointer: ChildProcess | null;
  pointerStart: Point | null;
  pointerFinishing: boolean;
  settingsCache: AppSettings;
  hotkeyRegistrations: HotkeyRegistration[];
};

type HotkeyRegistration = {
  action: string;
  requested: string;
  accelerator: string;
  registered: boolean;
  reason: "empty" | "invalid" | "duplicate" | "occupied" | null;
};

let interactionLock = false;
let dragOrigin: Electron.Rectangle | null = null;
let overlayMouseTimer: ReturnType<typeof setInterval> | null = null;
let lastRegionMode: "pointer" | "fallback" | null = null;
let overlayMouseApplyTimer: ReturnType<typeof setTimeout> | null = null;
let appliedIgnoreMouse: boolean | null = null;
let boundsSaveTimer: ReturnType<typeof setTimeout> | null = null;
let overlayHitRegions: OverlayHitRegion[] = [];
let overlayKeyboardMode = false;

function commitOverlayMouseState(ignore: boolean): void {
  const win = state.overlay;
  if (!win || win.isDestroyed()) return;
  if (appliedIgnoreMouse === ignore) return;
  appliedIgnoreMouse = ignore;
  win.setIgnoreMouseEvents(ignore, { forward: true });
}

function applyOverlayMouseState(immediate = false): void {
  const win = state.overlay;
  if (!win || win.isDestroyed()) return;
  const settings = state.service?.settings ?? state.settingsCache;
  let ignore = false;
  if (settings.overlay.clickThrough && !interactionLock) {
    const zone = overlayHitZone(screen.getCursorScreenPoint(), win.getBounds(), {
      regions: overlayHitRegions,
    });
    if (!zone.inside) {
      ignore = true;
    } else {
      ignore = !(zone.drag || zone.resize || zone.control);
    }
  }
  if (overlayMouseApplyTimer) {
    clearTimeout(overlayMouseApplyTimer);
    overlayMouseApplyTimer = null;
  }
  if (immediate || ignore === appliedIgnoreMouse) {
    commitOverlayMouseState(ignore);
    return;
  }
  overlayMouseApplyTimer = setTimeout(() => {
    overlayMouseApplyTimer = null;
    commitOverlayMouseState(ignore);
  }, 40);
}

function startOverlayMouseWatch(win: BrowserWindow): void {
  if (overlayMouseTimer) clearInterval(overlayMouseTimer);
  overlayMouseTimer = setInterval(() => {
    if (win.isDestroyed() || !win.isVisible()) return;
    applyOverlayMouseState(true);
  }, 16);
}

function stopOverlayMouseWatch(): void {
  if (overlayMouseTimer) clearInterval(overlayMouseTimer);
  overlayMouseTimer = null;
  if (overlayMouseApplyTimer) clearTimeout(overlayMouseApplyTimer);
  overlayMouseApplyTimer = null;
  appliedIgnoreMouse = null;
}

const state: AppState = {
  service: null as unknown as AppService,
  logger: null as unknown as Logger,
  overlay: null,
  tray: null,
  region: null,
  regionDisplayId: null,
  regionReadyResolve: null,
  regionRestoreOverlay: false,
  regionOpening: false,
  pointer: null,
  pointerStart: null,
  pointerFinishing: false,
  settingsCache: defaultSettings(),
  hotkeyRegistrations: [],
};

/**
 * The overlay must never become the foreground window: exam proctoring pages
 * commonly listen for blur/visibilitychange, so a normal show()/focus() would
 * look like a display switch. showInactive() keeps the exam window focused
 * while the overlay still paints and receives mouse input.
 */
function showOverlay(): void {
  const win = state.overlay;
  if (!win || win.isDestroyed()) return;
  // Keep the overlay out of the taskbar and Alt+Tab. On Windows this maps to
  // WS_EX_TOOLWINDOW, so the overlay stays invisible to window switchers even
  // after it is hidden and restored. The tray icon and Ctrl+B remain available
  // as recovery paths.
  if (process.platform === "win32") win.setSkipTaskbar(true);
  win.showInactive();
  refreshTrayMenu();
}

/**
 * Text fields still need real keyboard focus. This is the only path that may
 * activate the overlay, and the renderer turns it off as soon as the editable
 * control loses focus so ordinary button clicks never steal focus.
 */
function setOverlayKeyboard(active: boolean): { active: boolean; focusable: boolean } {
  const win = state.overlay;
  if (!win || win.isDestroyed()) return { active: false, focusable: false };
  if (active === overlayKeyboardMode) {
    return { active, focusable: win.isFocusable() };
  }
  overlayKeyboardMode = active;
  appliedIgnoreMouse = null;
  if (active) {
    interactionLock = true;
    try {
      win.setFocusable(true);
    } catch (error) {
      state.logger?.warn("failed to make overlay focusable", { message: String(error) });
    }
    if (!win.isVisible()) win.show();
    win.focus();
  } else {
    interactionLock = false;
    if (win.isFocused()) win.blur();
    try {
      win.setFocusable(false);
    } catch (error) {
      state.logger?.warn("failed to make overlay non-activating", { message: String(error) });
    }
    if (win.isVisible()) win.showInactive();
  }
  applyOverlayMouseState(true);
  return { active: overlayKeyboardMode, focusable: !win.isDestroyed() && win.isFocusable() };
}

function hideOverlay(): void {
  const win = state.overlay;
  if (!win || win.isDestroyed()) return;
  overlayKeyboardMode = false;
  interactionLock = false;
  win.hide();
  try {
    win.setFocusable(false);
  } catch (error) {
    state.logger?.warn("failed to reset overlay focusability", { message: String(error) });
  }
  refreshTrayMenu();
}

function refreshTrayMenu(): void {
  const tray = state.tray;
  if (!tray || tray.isDestroyed()) return;
  const win = state.overlay;
  const visible = Boolean(win && !win.isDestroyed() && win.isVisible());
  tray.setToolTip(visible ? "Desktophelper · 浮层已显示" : "Desktophelper · 已隐藏（单击恢复）");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: visible ? "隐藏浮层" : "显示浮层",
        click: () => {
          if (win && !win.isDestroyed() && win.isVisible()) hideOverlay();
          else showOverlay();
        },
      },
      { type: "separator" },
      { label: "区域截图", click: () => void openRegionSelector() },
      { label: "全屏截图", click: () => void state.service.captureFull().catch(() => undefined) },
      { type: "separator" },
      { label: "退出 Desktophelper", click: () => app.quit() },
    ]),
  );
}

function createTray(): void {
  if (state.tray) return;
  const image = nativeImage.createFromPath(join(outDir, "assets", "icon.png"));
  if (image.isEmpty()) {
    state.logger?.warn("tray icon missing", { path: join(outDir, "assets", "icon.png") });
    return;
  }
  const tray = new Tray(image.resize({ width: 16, height: 16 }));
  tray.on("click", () => {
    const win = state.overlay;
    if (!win || win.isDestroyed()) return;
    if (win.isVisible()) hideOverlay();
    else showOverlay();
  });
  state.tray = tray;
  refreshTrayMenu();
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

function broadcast(name: EventName, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send("dh:event", { name, payload });
  }
}

function applyCaptureProtection(win: BrowserWindow | null, settings: AppSettings): void {
  if (!win || win.isDestroyed()) return;
  try {
    win.setContentProtection(Boolean(settings.privacy.excludeFromCapture));
  } catch (error) {
    state.logger?.warn("failed to apply capture protection", { message: String(error) });
  }
}

function registerAppProtocol(): void {
  protocol.handle(APP_SCHEME, async (request) => {
    try {
      const url = new URL(request.url);
      if (url.host !== APP_HOST) return new Response("not found", { status: 404 });
      const relative = decodeURIComponent(url.pathname).replace(/^\/+/, "");
      const root = resolve(outDir);
      const target = resolve(root, relative);
      if (!target.startsWith(root + sep) || !existsSync(target)) {
        return new Response("not found", { status: 404 });
      }
      const info = await stat(target);
      if (!info.isFile()) return new Response("not found", { status: 404 });
      const body = await readFile(target);
      const type = MIME[extname(target).toLowerCase()] ?? "application/octet-stream";
      return new Response(body, {
        status: 200,
        headers: {
          "content-type": type,
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
        },
      });
    } catch (error) {
      return new Response(`error: ${(error as Error).message}`, { status: 500 });
    }
  });
}

function registerDisplayMediaHandler(): void {
  electronSession.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
    try {
      const sources = await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: { width: 0, height: 0 } });
      if (sources.length === 0) {
        callback({});
        return;
      }
      const primaryId = String(screen.getPrimaryDisplay().id);
      const source = sources.find((entry) => entry.display_id === primaryId) ?? sources[0];
      callback({
        video: source,
        ...(process.platform === "win32" ? { audio: "loopback" as const } : {}),
      });
    } catch (error) {
      state.logger?.warn("display media request failed", { message: String(error) });
      callback({});
    }
  });
}

function createOverlayWindow(): BrowserWindow {
  interactionLock = false;
  dragOrigin = null;
  const settings = state.service.settings;
  const bounds = settings.overlay.bounds;
  const primary = screen.getPrimaryDisplay().workArea;
  const compact = settings.overlay.compact;
  const width = compact ? Math.min(bounds?.width ?? 430, 480) : Math.min(bounds?.width ?? 860, 1080);
  const height = bounds?.height ?? 680;
  const win = new BrowserWindow({
    width,
    height,
    icon: join(outDir, "assets", "icon.png"),
    x: bounds?.x ?? Math.max(primary.x + primary.width - width - 32, primary.x),
    y: bounds?.y ?? Math.max(primary.y + 48, primary.y),
    minWidth: 360,
    minHeight: 420,
    frame: false,
    thickFrame: false,
    maximizable: false,
    fullscreenable: false,
    transparent: true,
    backgroundColor: "#00000000",
    hasShadow: false,
    resizable: true,
    alwaysOnTop: settings.overlay.alwaysOnTop,
    skipTaskbar: true,
    // WS_EX_TOOLWINDOW on Windows keeps the overlay out of both the taskbar
    // and the Alt+Tab switcher, which `setSkipTaskbar` alone does not guarantee.
    type: process.platform === "win32" ? "toolbar" : undefined,
    // WS_EX_NOACTIVATE on Windows: mouse clicks still reach the renderer but
    // the window never takes foreground focus away from the exam page.
    focusable: false,
    show: false,
    title: "Desktophelper",
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      webSecurity: true,
      backgroundThrottling: false,
    },
  });

  // Apply the saved opacity before the first paint. Otherwise the first
  // settings update (for example a layout toggle) changes it mid-session.
  win.setOpacity(Math.max(0.2, Math.min(1, settings.overlay.opacity)));
  win.setMenuBarVisibility(false);
  win.setAlwaysOnTop(settings.overlay.alwaysOnTop, "screen-saver");
  try {
    win.setFocusable(false);
  } catch (error) {
    state.logger?.warn("failed to create non-activating overlay", { message: String(error) });
  }
  if (process.platform === "win32") win.setSkipTaskbar(true);
  applyCaptureProtection(win, settings);
  void win.loadURL(`${APP_SCHEME}://${APP_HOST}/renderer/index.html`);
  win.once("ready-to-show", () => {
    applyCaptureProtection(win, state.service.settings);
    showOverlay();
    appliedIgnoreMouse = null;
    applyOverlayMouseState(true);
    startOverlayMouseWatch(win);
  });
  win.on("focus", () => {
    interactionLock = true;
    appliedIgnoreMouse = null;
    applyOverlayMouseState(true);
  });
  win.on("blur", () => {
    interactionLock = false;
    appliedIgnoreMouse = null;
    if (overlayKeyboardMode) {
      overlayKeyboardMode = false;
      setTimeout(() => {
        if (win.isDestroyed()) return;
        try {
          win.setFocusable(false);
        } catch {
          // The window may be closing.
        }
        applyOverlayMouseState(true);
      }, 0);
    }
    applyOverlayMouseState(true);
  });
  win.on("moved", () => persistBounds(win));
  win.on("resized", () => persistBounds(win));
  win.on("close", () => {
    if (boundsSaveTimer) clearTimeout(boundsSaveTimer);
    boundsSaveTimer = null;
    if (!win.isDestroyed()) state.service.saveOverlayBounds(win.getBounds());
  });
  win.on("closed", () => {
    stopOverlayMouseWatch();
    if (state.overlay === win) state.overlay = null;
  });
  win.webContents.on("did-finish-load", () => {
    if (isE2E) void runE2EChecks(win);
  });
  win.webContents.on("render-process-gone", (_event, details: Electron.RenderProcessGoneDetails) => {
    state.logger.error("renderer gone", { reason: details.reason, exitCode: details.exitCode });
  });
  win.webContents.setWindowOpenHandler(({ url }: { url: string }) => {
    if (url.startsWith("https://") || url.startsWith("http://")) void shell.openExternal(url);
    return { action: "deny" };
  });
  return win;
}

function persistBounds(win: BrowserWindow): void {
  if (win.isDestroyed() || win.isMinimized()) return;
  const bounds = win.getBounds();
  if (boundsSaveTimer) clearTimeout(boundsSaveTimer);
  boundsSaveTimer = setTimeout(() => {
    boundsSaveTimer = null;
    if (win.isDestroyed()) return;
    state.service.saveOverlayBounds({ x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height });
  }, 220);
}

function applyOverlayLayout(compact: boolean): { compact: boolean; width: number; height: number } {
  const win = state.overlay;
  if (!win || win.isDestroyed()) return { compact, width: 0, height: 0 };
  const current = win.getBounds();
  const workArea = screen.getDisplayMatching(current).workArea;
  const targetWidth = compact
    ? Math.min(430, workArea.width)
    : Math.max(760, Math.min(960, Math.round(workArea.width * 0.62)));
  const targetHeight = compact
    ? Math.min(Math.max(current.height, 420), workArea.height)
    : Math.min(Math.max(current.height, 640), workArea.height);
  const right = current.x + current.width;
  const x = Math.max(workArea.x, Math.min(right - targetWidth, workArea.x + workArea.width - targetWidth));
  const y = Math.max(workArea.y, Math.min(current.y, workArea.y + workArea.height - targetHeight));
  win.setBounds({ x, y, width: targetWidth, height: targetHeight }, false);
  return { compact, width: targetWidth, height: targetHeight };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function configureRegionWindow(win: BrowserWindow | null): void {
  if (!win || win.isDestroyed()) return;
  try {
    // A full-screen protected window is excluded as one whole rectangle by
    // Windows capture pipelines, which turns the entire shared frame black.
    // The fallback selector therefore stays capturable and draws a frozen
    // preview instead. The real crop always comes from the pre-captured frame.
    win.setContentProtection(false);
  } catch (error) {
    state.logger?.warn("failed to configure region selector", { message: String(error) });
  }
}

function restoreOverlayAfterRegion(): void {
  if (!state.regionRestoreOverlay) return;
  state.regionRestoreOverlay = false;
  const win = state.overlay;
  if (!win || win.isDestroyed()) return;
  const settings = state.service?.settings ?? state.settingsCache;
  showOverlay();
  appliedIgnoreMouse = null;
  applyOverlayMouseState(true);
}

function pointerToDip(x: number, y: number, monitor?: MonitorInfo): Point {
  // Simulated E2E coordinates are already expressed in DIP.
  if (!monitor) return { x, y };
  const cursor = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(cursor);
  return physicalPointToDip({ x, y }, monitor, display);
}

function killPointerHelper(): void {
  const child = state.pointer;
  state.pointer = null;
  state.pointerStart = null;
  state.pointerFinishing = false;
  if (!child) return;
  try {
    child.stdin?.write("quit\n");
    child.stdin?.end();
  } catch {
    // already closed
  }
  const timer = setTimeout(() => {
    if (child.exitCode === null) {
      try { child.kill(); } catch { /* already gone */ }
    }
  }, 400);
  timer.unref?.();
}

async function cancelPointerSelection(reason: string): Promise<void> {
  if (reason === "timeout") broadcast("toast", { level: "warn", message: "区域截图已超时，请重试" });
  try {
    await state.service.cancelRegion();
  } catch (error) {
    state.logger?.warn("failed to cancel region selection", { reason, message: String(error) });
    closeRegionSelector();
  }
}

async function finishPointerSelection(start: Point, end: Point): Promise<void> {
  const child = state.pointer;
  if (!child) return;
  const display = screen.getAllDisplays().map((entry) => ({
    id: String(entry.id),
    x: entry.bounds.x,
    y: entry.bounds.y,
    width: entry.bounds.width,
    height: entry.bounds.height,
  }));
  state.logger?.debug("region pointer selection", {
    start,
    end,
    displays: display,
  });
  const target = regionOnDisplays(start, end, display);
  if (!target || !isUsableRegion(target.rect)) {
    broadcast("toast", { level: "warn", message: "选择区域太小，已取消截图" });
    await cancelPointerSelection("too-small");
    return;
  }
  try {
    // The overlay has been hidden since selection started, so this capture
    // contains the live desktop and never contains the selection UI itself.
    const capture = await captureDisplay(target.displayId);
    state.logger?.debug("region capture ready", {
      displayId: target.displayId,
      rect: target.rect,
      image: capture.image.getSize(),
      displaySize: capture.display.size,
      scaleFactor: capture.display.scaleFactor,
      screenToDipPoint: typeof (screen as unknown as { screenToDipPoint?: unknown }).screenToDipPoint,
    });
    rememberRegionCapture(capture);
    await state.service.submitRegion({
      displayId: target.displayId,
      rect: target.rect,
      scaleFactor: capture.display.scaleFactor,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    broadcast("toast", { level: "error", message: "区域截图失败：" + message });
    await cancelPointerSelection("error");
  } finally {
    state.pointerFinishing = false;
  }
}

function handlePointerEvent(event: PointerEvent, child: ChildProcess): void {
  if (state.pointer !== child) return;
  state.logger?.debug("pointer event", { event });
  if (event.type === "point") {
    state.pointerStart = pointerToDip(event.x, event.y, event.monitor);
  } else if (event.type === "done") {
    const start = state.pointerStart ?? pointerToDip(event.start.x, event.start.y, event.monitor);
    const end = pointerToDip(event.end.x, event.end.y, event.monitor);
    state.pointerStart = null;
    state.pointerFinishing = true;
    void finishPointerSelection(start, end);
  } else if (event.type === "cancel") {
    // A stale cancel must never discard a selection that already completed.
    if (state.pointerFinishing) return;
    state.pointerStart = null;
    void cancelPointerSelection(event.reason);
  }
}

function waitForPointerReady(
  child: ChildProcess,
  onEvent: (event: PointerEvent) => void,
  timeoutMs = 8000,
): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ready: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(ready);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    timer.unref?.();
    const reader = createInterface({ input: child.stdout! });
    reader.on("line", (line) => {
      const event = parsePointerEvent(line.trim());
      if (!event) return;
      if (!settled && event.type === "ready") {
        finish(true);
        return;
      }
      if (settled) onEvent(event);
    });
    reader.on("close", () => finish(false));
    child.once("error", () => finish(false));
    child.once("exit", () => finish(false));
  });
}

async function startPointerSelection(): Promise<boolean> {
  if (state.pointer) return true;
  const helper = join(outDir, "bin", "dh-pointer.exe");
  if (!existsSync(helper)) return false;
  const simulated = (process.env.DH_E2E_REGION_RECT ?? "")
    .split(",")
    .map((entry) => Number.parseInt(entry.trim(), 10));
  const args =
    simulated.length === 4 && simulated.every((entry) => Number.isFinite(entry))
      ? ["--simulate", ...simulated.map(String)]
      : [];
  state.pointerStart = null;
  state.pointerFinishing = false;
  const child = spawn(helper, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  state.pointer = child;
  let stderrTail = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderrTail = (stderrTail + chunk.toString("utf8")).slice(-2000);
  });
  child.once("error", (error) => {
    state.logger?.warn("pointer helper spawn failed", { message: String(error) });
  });
  const ready = await waitForPointerReady(child, (event) => handlePointerEvent(event, child));
  if (!ready) {
    state.logger?.warn("pointer helper not ready", {
      exitCode: child.exitCode,
      signal: child.signalCode,
      stderr: stderrTail || null,
    });
    killPointerHelper();
    return false;
  }
  child.once("exit", () => {
    if (state.pointer !== child) return;
    state.pointer = null;
    restoreOverlayAfterRegion();
    broadcast("toast", { level: "error", message: "区域截图工具已退出，请重试" });
  });
  // The overlay is content-protected, so this shortcut stays visible to the
  // user while remaining out of the shared screen. Give it a moment to be
  // read before the overlay is hidden and the pointer helper is armed.
  broadcast("toast", {
    level: "info",
    message: "点击左上角起点，再点击右下角终点；Esc 或右键取消",
  });
  await delay(700);
  const overlay = state.overlay;
  const overlayWasVisible = Boolean(overlay && !overlay.isDestroyed() && overlay.isVisible());
  state.regionRestoreOverlay = overlayWasVisible;
  if (overlayWasVisible) hideOverlay();
  await delay(90);
  try {
    state.pointerStart = null;
    child.stdin?.write("arm\n");
  } catch (error) {
    state.logger?.warn("failed to arm pointer helper", { message: String(error) });
    killPointerHelper();
    restoreOverlayAfterRegion();
    return false;
  }
  state.logger?.info("region selection armed", {
    mode: "pointer",
    displays: screen.getAllDisplays().length,
  });
  return true;
}

async function openRegionSelector(): Promise<boolean> {
  if (state.pointer) return true;
  if (await startPointerSelection()) {
    lastRegionMode = "pointer";
    return true;
  }
  lastRegionMode = "fallback";
  state.logger?.warn("region selector fallback window", { reason: "pointer helper unavailable" });
  return openFallbackRegionSelector();
}

async function openFallbackRegionSelector(): Promise<boolean> {
  if (state.region && !state.region.isDestroyed() && state.region.isVisible()) {
    state.region.focus();
    return true;
  }
  const cursor = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(cursor);
  const overlay = state.overlay;
  const overlayWasVisible = Boolean(overlay && !overlay.isDestroyed() && overlay.isVisible());
  state.regionRestoreOverlay = overlayWasVisible;
  state.regionOpening = true;
  if (overlayWasVisible) hideOverlay();

  try {
    // Let DWM composite the hidden overlay before taking the clean frame. This
    // frame is both the frozen preview and the source for the final crop, so
    // the selector mask can never end up inside the saved screenshot.
    await delay(90);
    const capture = await captureDisplay(String(display.id));
    rememberRegionCapture(capture);

    if (!state.region || state.region.isDestroyed()) {
      state.region = new BrowserWindow({
        x: display.bounds.x,
        y: display.bounds.y,
        width: display.bounds.width,
        height: display.bounds.height,
        frame: false,
        transparent: false,
        backgroundColor: "#0b0d12",
        hasShadow: false,
        thickFrame: false,
        alwaysOnTop: true,
        skipTaskbar: true,
        resizable: false,
        movable: false,
        minimizable: true,
        maximizable: false,
        fullscreenable: false,
        fullscreen: false,
        show: false,
        webPreferences: {
          preload: preloadPath,
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          spellcheck: false,
          backgroundThrottling: false,
        },
      });
      state.region.setAlwaysOnTop(true, "screen-saver");
      state.region.setMenuBarVisibility(false);
      if (process.platform === "darwin") {
        state.region.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
      }
      state.region.on("closed", () => {
        state.region = null;
        state.regionReadyResolve = null;
        clearPendingRegionCapture();
        restoreOverlayAfterRegion();
      });
      state.region.webContents.on(
        "render-process-gone",
        (_event, details: Electron.RenderProcessGoneDetails) => {
          state.logger.error("region renderer gone", { reason: details.reason, exitCode: details.exitCode });
        },
      );
    }
    state.regionDisplayId = String(display.id);
    state.region.setBounds(display.bounds);
    configureRegionWindow(state.region);

    const query = new URLSearchParams({
      displayId: String(display.id),
      x: String(display.bounds.x),
      y: String(display.bounds.y),
      width: String(display.bounds.width),
      height: String(display.bounds.height),
    });
    const ready = new Promise<void>((resolve) => {
      state.regionReadyResolve = resolve;
    });
    await state.region.loadURL(`${APP_SCHEME}://${APP_HOST}/renderer/region.html?${query.toString()}`);
    // A selector window must never be shown before the frozen preview has
    // actually painted. Showing early is what produced a black full-screen
    // flash followed by a silent cancel on slow DPI-scaled captures.
    const rendered = await Promise.race([
      ready.then(() => true),
      delay(12000).then(() => false),
    ]);
    state.regionReadyResolve = null;
    if (!rendered) {
      state.logger?.warn("region selector preview timeout", {
        displayId: String(display.id),
      });
      state.regionOpening = false;
      clearPendingRegionCapture();
      if (state.region && !state.region.isDestroyed()) state.region.hide();
      restoreOverlayAfterRegion();
      broadcast("toast", { level: "error", message: "截图预览加载超时，请重试" });
      return false;
    }
    if (!state.regionOpening) return false;
    state.regionOpening = false;
    if (!state.region || state.region.isDestroyed()) return false;
    configureRegionWindow(state.region);
    await state.region.webContents
      .executeJavaScript(
        "new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
        true,
      )
      .catch(() => undefined);
    state.region.show();
    state.region.focus();
    return true;
  } catch (error) {
    state.regionOpening = false;
    clearPendingRegionCapture();
    state.regionReadyResolve = null;
    if (state.region && !state.region.isDestroyed()) state.region.hide();
    restoreOverlayAfterRegion();
    throw error;
  }
}

function closeRegionSelector(): boolean {
  state.regionOpening = false;
  clearPendingRegionCapture();
  const hadPointer = Boolean(state.pointer);
  killPointerHelper();
  if (!state.region || state.region.isDestroyed()) {
    restoreOverlayAfterRegion();
    return hadPointer;
  }
  state.regionReadyResolve = null;
  state.region.hide();
  restoreOverlayAfterRegion();
  return true;
}

const overlayBridge: OverlayBridge = {
  apply(settings) {
    state.settingsCache = settings;
    const win = state.overlay;
    if (!win || win.isDestroyed()) return;
    win.setAlwaysOnTop(settings.overlay.alwaysOnTop, "screen-saver");
    win.setOpacity(Math.max(0.2, Math.min(1, settings.overlay.opacity)));
    applyOverlayMouseState(true);
    applyCaptureProtection(win, settings);
    broadcast("state", state.service.snapshot());
  },
  toggle() {
    const win = state.overlay;
    if (!win || win.isDestroyed()) return false;
    if (win.isVisible()) hideOverlay();
    else showOverlay();
    applyOverlayMouseState(true);
    return win.isVisible();
  },
  setClickThrough(value) {
    const win = state.overlay;
    if (!win || win.isDestroyed()) return;
    appliedIgnoreMouse = null;
    win.setIgnoreMouseEvents(value, { forward: true });
    applyOverlayMouseState(true);
  },
  setInteraction(active) {
    interactionLock = active;
    appliedIgnoreMouse = null;
    applyOverlayMouseState(true);
  },
  drag(phase, dx = 0, dy = 0) {
    const win = state.overlay;
    if (!win || win.isDestroyed()) return;
    if (phase === "start") {
      dragOrigin = win.getBounds();
      interactionLock = true;
      appliedIgnoreMouse = null;
      applyOverlayMouseState(true);
      return;
    }
    if (phase === "end") {
      dragOrigin = null;
      interactionLock = false;
      appliedIgnoreMouse = null;
      applyOverlayMouseState(true);
      return;
    }
    if (!dragOrigin) dragOrigin = win.getBounds();
    const before = win.getBounds();
    const target = overlayDragBounds(dragOrigin, dx, dy);
    if (
      before.x !== target.x ||
      before.y !== target.y ||
      before.width !== target.width ||
      before.height !== target.height
    ) {
      // setPosition alone drifts the height on Windows at fractional DPI
      // (150%): every call rounds the physical size up. Re-applying the
      // original size keeps a drag a pure move.
      win.setBounds(target, false);
    }
    const after = win.getBounds();
    if (after.width !== dragOrigin.width || after.height !== dragOrigin.height) {
      state.logger.warn("overlay drag changed size", { dx, dy, before, after });
    }
    applyOverlayMouseState(true);
  },
  move(dx, dy) {
    const win = state.overlay;
    if (!win || win.isDestroyed()) return;
    const bounds = win.getBounds();
    // Keep the exact original size. Re-applying width/height avoids the
    // fractional-DPI rounding growth seen with setPosition() on Windows.
    win.setBounds(
      { x: bounds.x + Math.round(dx), y: bounds.y + Math.round(dy), width: bounds.width, height: bounds.height },
      false,
    );
    applyOverlayMouseState(true);
  },
  resize(size) {
    const win = state.overlay;
    if (!win || win.isDestroyed()) return;
    const bounds = win.getBounds();
    win.setBounds({ x: bounds.x, y: bounds.y, width: size.width, height: size.height }, false);
    applyOverlayMouseState(true);
  },
  openRegionSelector,
  closeRegionSelector,
};

const hotkeyBridge: HotkeyBridge = {
  apply(settings) {
    globalShortcut.unregisterAll();
    const registrations: HotkeyRegistration[] = [];
    const failures: Array<{ action: string; requested: string; accelerator: string }> = [];
    const claimed = new Map<string, string>();
    const register = (action: string, requested: string, handler: () => void) => {
      if (!requested) {
        registrations.push({ action, requested, accelerator: "", registered: false, reason: "empty" });
        return;
      }
      if (!requested.includes("+")) {
        failures.push({ action, requested, accelerator: requested });
        registrations.push({ action, requested, accelerator: requested, registered: false, reason: "invalid" });
        return;
      }
      const accelerator = toGlobalAccelerator(requested, process.platform);
      if (!accelerator || !accelerator.includes("+")) {
        failures.push({ action, requested, accelerator });
        registrations.push({ action, requested, accelerator, registered: false, reason: "invalid" });
        return;
      }
      const key = accelerator.toLowerCase();
      const owner = claimed.get(key);
      if (owner) {
        state.logger.warn("hotkey duplicate binding", { action, requested, accelerator, owner });
        failures.push({ action, requested, accelerator });
        registrations.push({ action, requested, accelerator, registered: false, reason: "duplicate" });
        return;
      }
      claimed.set(key, action);
      let registered = false;
      try {
        registered = globalShortcut.register(accelerator, handler);
        if (!registered) {
          state.logger.warn("hotkey registration failed", { action, requested, accelerator });
          failures.push({ action, requested, accelerator });
        }
      } catch (error) {
        state.logger.warn("hotkey invalid", { action, requested, accelerator, error: String(error) });
        failures.push({ action, requested, accelerator });
      }
      registrations.push({
        action,
        requested,
        accelerator,
        registered,
        reason: registered ? null : "occupied",
      });
    };
    const send = (type: string, extra: Record<string, unknown> = {}) => broadcast("command", { type, ...extra });
    const hotkeys = settings.hotkeys;
    register("toggleOverlay", hotkeys.toggleOverlay, () => overlayBridge.toggle());
    register("emergencyHide", hotkeys.emergencyHide, () => send("emergency-hide"));
    register("captureRegion", hotkeys.captureRegion, () => void openRegionSelector());
    register("captureFull", hotkeys.captureFull, () => void state.service.captureFull().catch(() => undefined));
    register("toggleListening", hotkeys.toggleListening, () => send("toggle-listening"));
    register("solveGroup", hotkeys.solveGroup, () => send("solve-group"));
    register("toggleKnowledge", hotkeys.toggleKnowledge, () => send("toggle-knowledge"));
    register("resetView", hotkeys.resetView, () => send("reset-view"));
    register("quit", hotkeys.quit, () => app.quit());
    register("moveLeft", hotkeys.moveLeft, () => overlayBridge.move(-24, 0));
    register("moveRight", hotkeys.moveRight, () => overlayBridge.move(24, 0));
    register("moveUp", hotkeys.moveUp, () => overlayBridge.move(0, -24));
    register("moveDown", hotkeys.moveDown, () => overlayBridge.move(0, 24));
    register("opacityDown", hotkeys.opacityDown, () => void state.service.nudgeOverlayOpacity(-0.05).catch(() => undefined));
    register("opacityUp", hotkeys.opacityUp, () => void state.service.nudgeOverlayOpacity(0.05).catch(() => undefined));
    register("zoomOut", hotkeys.zoomOut, () => send("zoom", { delta: -0.1 }));
    register("zoomReset", hotkeys.zoomReset, () => send("zoom", { delta: 0, reset: true }));
    register("zoomIn", hotkeys.zoomIn, () => send("zoom", { delta: 0.1 }));
    register("deleteLastShot", hotkeys.deleteLastShot, () => send("delete-last-shot"));
    register("answerQuestion", hotkeys.answerQuestion, () => send("answer-question"));
    register("voiceSolve", hotkeys.voiceSolve, () => send("voice-solve"));
    register("pagePrev", hotkeys.pagePrev, () => send("page-prev"));
    register("pageNext", hotkeys.pageNext, () => send("page-next"));
    register("scrollUp", hotkeys.scrollUp, () => send("scroll-up"));
    register("scrollDown", hotkeys.scrollDown, () => send("scroll-down"));
    state.hotkeyRegistrations = registrations;
    const active = registrations.filter((entry) => entry.registered).length;
    state.logger.info("hotkeys registered", { active, total: registrations.length });
    if (failures.length > 0) {
      const labels = failures.map((entry) => entry.requested || entry.action).join("、");
      state.logger.warn("hotkey registration incomplete", { failures });
      broadcast("toast", { level: "warn", message: `部分快捷键注册失败或被占用：${labels}` });
    }
  },
};

function assertTrustedSender(event: Electron.IpcMainInvokeEvent): void {
  const url = event.senderFrame?.url ?? "";
  if (!url.startsWith(`${APP_SCHEME}://${APP_HOST}/`)) {
    throw new AppError("UNAUTHORIZED", "不可信的调用来源");
  }
}

const LOCK_EXEMPT = new Set<string>([
  "app.snapshot",
  "app.ready",
  "lock.status",
  "lock.unlock",
  "lock.set",
  "lock.clear",
  "secrets.status",
  "overlay.keyboard",
]);

async function callChannel(channel: Channel, payload: any): Promise<unknown> {
  const service = state.service;
  switch (channel) {
    case "app.snapshot":
      return service.snapshot();
    case "app.ready":
      return { ok: true };
    case "settings.update":
      return service.updateSettings(payload);
    case "settings.reset":
      return service.resetSettings();
    case "secrets.status":
      return service.secrets.status();
    case "secrets.set":
      return service.setSecret(payload.key, payload.value);
    case "secrets.clear":
      return service.clearSecret(payload.key);
    case "providers.test":
      return service.testService(payload.service);
    case "session.new":
      return service.newSession();
    case "session.load":
      return service.loadSession(payload.id);
    case "session.list":
      return service.snapshot().sessions;
    case "session.rename":
      return service.renameSession(payload.title, payload.id);
    case "session.delete":
      return service.deleteSession(payload.id);
    case "session.clearSegments":
      return service.clearSegments();
    case "transcript.append":
      return service.appendTranscript(payload);
    case "transcript.setSpeaker":
      return service.setSegmentSpeaker(payload.id, payload.speaker);
    case "listening.update":
      return service.setListening(payload);
    case "transcribe.audio":
      return service.transcribe(payload);
    case "transcribe.startRealtime":
      return service.startRealtime(payload.channel);
    case "transcribe.pushPcm":
      return service.pushRealtime(payload);
    case "transcribe.stopRealtime":
      return service.stopRealtime(payload.channel);
    case "trigger.manual":
      return service.manualTrigger(payload.text, payload.ask);
    case "answer.start":
      return service.startAnswer(payload.question, payload.trigger ?? "manual");
    case "answer.cancel":
      return service.cancelAnswer(payload.answerId);
    case "answer.retry":
      return service.retryAnswer(payload.answerId);
    case "queue.next":
      return service.queueNext();
    case "queue.remove":
      return service.queueRemove(payload.id);
    case "queue.clear":
      return service.queueClear();
    case "screenshot.captureFull":
      return service.captureFull();
    case "screenshot.captureRegion":
      return service.openRegionSelector();
    case "screenshot.regionPreview": {
      const preview = getRegionPreview(payload.displayId);
      if (!preview) throw new AppError("CONFLICT", "截图预览已失效，请重新截图");
      return preview;
    }
    case "screenshot.regionReady":
      state.regionReadyResolve?.();
      state.regionReadyResolve = null;
      return { ready: true };
    case "screenshot.submitRegion":
      return service.submitRegion(payload);
    case "screenshot.cancelRegion":
      return service.cancelRegion();
    case "screenshot.analyze":
      return service.analyzeScreenshot(payload.id, payload.note, payload.strategy);
    case "screenshot.solve":
      return service.solveGroup(payload.groupId, payload.note, payload.strategy);
    case "screenshot.retry":
      return service.retryGroup(payload.groupId);
    case "screenshot.stopGroup":
      return service.stopGroup(payload.groupId);
    case "screenshot.extractGroup":
      return service.extractGroup(payload.groupId);
    case "screenshot.reopen":
      return service.reopenGroup(payload.groupId);
    case "screenshot.closeGroup":
      return service.closeGroup(payload.groupId);
    case "screenshot.deleteGroup":
      return service.deleteGroup(payload.groupId);
    case "screenshot.extract":
      return service.extractScreenshot(payload.id);
    case "screenshot.continue":
      return service.continueScreenshot(payload.id, payload.previousAnswerId, payload.note);
    case "screenshot.read":
      return service.readScreenshot(payload.id);
    case "screenshot.archive":
      return service.archiveWithRetry(payload.id, payload.guard);
    case "screenshot.delete":
      return service.deleteScreenshot(payload.id);
    case "screenshot.list":
      return service.listScreenshots();
    case "kb.list":
      return service.snapshot().kb;
    case "kb.pickAndImport":
      return service.pickAndImportKnowledge();
    case "kb.importText":
      return service.importKnowledgeText(payload.name, payload.text);
    case "kb.delete":
      return service.deleteKnowledgeDoc(payload.id);
    case "kb.search":
      return service.searchKnowledge(payload.query, payload.topK);
    case "overlay.update":
      return service.updateOverlay(payload);
    case "overlay.toggle":
      return service.toggleOverlay();
    case "overlay.hide": {
      const win = state.overlay;
      const wasVisible = Boolean(win && !win.isDestroyed() && win.isVisible());
      hideOverlay();
      return { hidden: wasVisible };
    }
    case "overlay.hover":
      return service.hoverOverlay(payload.inside);
    case "overlay.interaction":
      return service.setOverlayInteraction(payload.active);
    case "overlay.keyboard":
      return setOverlayKeyboard(payload.active);
    case "overlay.hitRegions":
      overlayHitRegions = payload.regions;
      applyOverlayMouseState(true);
      return { regions: overlayHitRegions.length };
    case "system.copyText":
      clipboard.writeText(payload.text);
      return { copied: true };
    case "hotkey.status":
      return {
        platform: process.platform,
        registrations: state.hotkeyRegistrations.map((entry) => ({
          ...entry,
          active: Boolean(entry.accelerator) && globalShortcut.isRegistered(entry.accelerator),
        })),
      };
    case "overlay.drag":
      return service.dragOverlay(payload.phase, payload.dx, payload.dy);
    case "overlay.resize":
      return service.resizeOverlay(payload);
    case "overlay.layout":
      return applyOverlayLayout(payload.compact);
    case "lock.status":
      return service.lockStatus();
    case "lock.unlock":
      return service.unlock(payload.passcode);
    case "lock.set":
      return service.setLock(payload.passcode);
    case "lock.clear":
      return service.clearLock(payload.passcode);
    default:
      throw new AppError("VALIDATION", `未知的通道：${String(channel)}`);
  }
}

function registerIpc(): void {
  for (const channel of Object.keys(payloadSchemas) as Channel[]) {
    if (!isChannel(channel)) continue;
    ipcMain.handle(channel, async (event, rawPayload) => {
      try {
        assertTrustedSender(event);
        const payload = validatePayload(channel, rawPayload) as PayloadOf<Channel>;
        if (state.service.isLocked() && !LOCK_EXEMPT.has(channel)) {
          throw new AppError("LOCKED", "应用已锁定，请先解锁");
        }
        const data = await callChannel(channel, payload);
        return ok(data);
      } catch (error) {
        return { ok: false, error: toIpcError(error) };
      }
    });
  }
}

async function runE2EChecks(win: BrowserWindow): Promise<void> {
  const marker = process.env.DH_E2E_OUT;
  const append = (line: string) => {
    console.log(line);
    if (marker) {
      try {
        appendFileSync(marker, `${line}\n`, "utf8");
      } catch {
        // ignore
      }
    }
  };
  try {
    const probe = await win.webContents.executeJavaScript(`(() => {
      const api = window.desktophelper || null;
      return {
        url: location.href,
        hasAppRoot: Boolean(document.querySelector("#app")),
        hasLogin: Boolean(document.querySelector("[data-testid=login]")),
        nodeRequire: typeof window.require,
        nodeProcess: typeof window.process,
        hasApi: Boolean(api),
        apiKeys: api ? Object.keys(api).sort() : [],
        hasAutoAnswerControl: Boolean(document.querySelector("#auto-answer")),
        hasClickThroughControl: Boolean(document.querySelector("#click-through")),
        hasClickThroughHotkeyControl: Boolean(document.querySelector("#hotkey-click")),
        hasSessionTitle: Boolean(document.querySelector("#session-title")),
        navTabs: Array.from(document.querySelectorAll(".nav-strip [data-tab]")).map((node) => node.getAttribute("data-tab")),
        statusLights: Array.from(document.querySelectorAll("#status-lights .status-light")).map((node) => node.textContent?.trim() || ""),
        footerShortcuts: document.querySelectorAll(".shortcut-bar button").length,
        bodyText: (document.body.innerText || "").slice(0, 300),
      };
    })()`);
    const windowOpacity = win.getOpacity();
    const expectedOpacity = state.service.settings.overlay.opacity;
    append(`DH_E2E_CHECK ${JSON.stringify({ ...probe, windowOpacity, expectedOpacity })}`);
  } catch (error) {
    append(`DH_E2E_ERROR ${String(error)}`);
  }
  try {
    const registrations = state.hotkeyRegistrations.map((entry) => ({
      ...entry,
      active: globalShortcut.isRegistered(entry.accelerator),
    }));
    append(`DH_E2E_HOTKEYS ${JSON.stringify({ platform: process.platform, registrations })}`);
  } catch (error) {
    append(`DH_E2E_HOTKEYS_ERROR ${String(error)}`);
  }
  try {
    const groupProbe = await win.webContents.executeJavaScript(`(async () => {
      await window.desktophelper.invoke("screenshot.captureFull");
      const tab = document.querySelector('[data-tab="shots"]');
      if (tab instanceof HTMLElement) tab.click();
      await new Promise((resolve) => setTimeout(resolve, 800));
      const card = document.querySelector("#shots .group");
      const trigger = card?.querySelector(".menu-trigger");
      if (trigger instanceof HTMLElement) trigger.click();
      const menuOpen = Boolean(trigger?.closest(".menu-wrap")?.classList.contains("open"));
      const menuItems = Array.from(card?.querySelectorAll(".menu button") || []).map(
        (button) => button.textContent?.trim() || "",
      );
      if (trigger instanceof HTMLElement) trigger.click();
      const result = {
        groups: document.querySelectorAll("#shots .group").length,
        title: card?.querySelector(".group-name")?.textContent?.trim() || "",
        thumbs: card?.querySelectorAll(".group-thumb").length || 0,
        thumbDeletes: card?.querySelectorAll(".group-thumb .thumb-delete").length || 0,
        firstDeleteDisabled: Boolean(card?.querySelector(".group-thumb .thumb-delete")?.disabled),
        mainLabel: card?.querySelector(".group-actions > button")?.textContent?.trim() || "",
        menuLabel: card?.querySelector(".menu-trigger")?.textContent?.trim() || "",
        menuOpen,
        menuItems,
        visible: Boolean(document.querySelector("#tab-shots.active")),
      };
      const deleteButton = card?.querySelector(".group-thumb .thumb-delete");
      if (deleteButton instanceof HTMLElement) deleteButton.click();
      await new Promise((resolve) => setTimeout(resolve, 500));
      return {
        ...result,
        groupsAfterDelete: document.querySelectorAll("#shots .group").length,
        deleteActionWorked: document.querySelectorAll("#shots .group").length === 0,
      };
    })()`);
    append(`DH_E2E_GROUPS ${JSON.stringify(groupProbe)}`);
  } catch (error) {
    append(`DH_E2E_GROUPS_ERROR ${String(error)}`);
  }
  try {
    const regionProbe = await win.webContents.executeJavaScript(`(async () => {
      const before = (await window.desktophelper.invoke("screenshot.list")).data.length;
      const opened = await window.desktophelper.invoke("screenshot.captureRegion");
      await new Promise((resolve) => setTimeout(resolve, 1800));
      const list = await window.desktophelper.invoke("screenshot.list");
      const latest = list.data[list.data.length - 1];
      return {
        opened: opened.data.opened,
        before,
        count: list.data.length,
        meta: latest ? {
          mode: latest.mode,
          width: latest.width,
          height: latest.height,
          file: latest.file,
        } : null,
      };
    })()`);
    let brightness: number | null = null;
    if (regionProbe.meta?.file) {
      const bytes = await readFile(join(app.getPath("userData"), "screenshots", regionProbe.meta.file));
      const image = nativeImage.createFromBuffer(bytes);
      const bitmap = image.toBitmap();
      let sum = 0;
      let samples = 0;
      for (let index = 0; index + 2 < bitmap.length; index += 64) {
        sum += (bitmap[index] + bitmap[index + 1] + bitmap[index + 2]) / 3;
        samples += 1;
      }
      brightness = samples > 0 ? Math.round((sum / samples) * 10) / 10 : null;
    }
    append(
      `DH_E2E_REGION ${JSON.stringify({
        ...regionProbe,
        scaleFactor: screen.getPrimaryDisplay().scaleFactor,
        mode: lastRegionMode,
        brightness,
      })}`,
    );
  } catch (error) {
    append(`DH_E2E_REGION_ERROR ${String(error)}`);
  }
  try {
    const groupNavProbe = await win.webContents.executeJavaScript(`(async () => {
      const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      document.querySelector('[data-tab="shots"]')?.click();
      await wait(150);
      const first = document.querySelector("#shots .group")?.getAttribute("data-group-id") || "";
      if (!first) return { error: "no screenshot group to close" };
      const closed = await window.desktophelper.invoke("screenshot.closeGroup", { groupId: first });
      if (!closed.ok) return { error: "closeGroup failed", detail: closed.error || null };
      await wait(200);
      await window.desktophelper.invoke("screenshot.captureFull");
      await wait(700);
      const nav = document.getElementById("group-nav");
      if (!(nav instanceof HTMLElement)) return { error: "group navigation is missing" };
      const title = () => document.getElementById("group-position")?.textContent?.trim() || "";
      const before = title();
      const box = nav.getBoundingClientRect();
      const pointer = {
        bubbles: true,
        cancelable: true,
        pointerId: 991,
        pointerType: "touch",
        isPrimary: true,
        button: 0,
        clientY: box.top + box.height / 2,
      };
      nav.dispatchEvent(new PointerEvent("pointerdown", { ...pointer, clientX: box.left + box.width - 24, buttons: 1 }));
      nav.dispatchEvent(new PointerEvent("pointermove", { ...pointer, clientX: box.left + 24, buttons: 1 }));
      nav.dispatchEvent(new PointerEvent("pointerup", { ...pointer, clientX: box.left + 24, buttons: 0 }));
      await wait(220);
      const after = title();
      document.getElementById("group-prev")?.click();
      await wait(180);
      const nextButton = document.getElementById("group-next");
      const prevButton = document.getElementById("group-prev");
      if (!(nextButton instanceof HTMLElement) || !(prevButton instanceof HTMLElement)) {
        return { error: "group arrows are missing" };
      }
      const nextBox = nextButton.getBoundingClientRect();
      const arrowStartX = nextBox.left + nextBox.width / 2;
      const arrowStartY = nextBox.top + nextBox.height / 2;
      let arrowClickSeen = false;
      const arrowClickSpy = () => {
        arrowClickSeen = true;
      };
      nextButton.addEventListener("click", arrowClickSpy);
      const arrowPointer = {
        bubbles: true,
        cancelable: true,
        pointerId: 992,
        pointerType: "touch",
        isPrimary: true,
        button: 0,
        clientY: arrowStartY,
      };
      nextButton.dispatchEvent(
        new PointerEvent("pointerdown", { ...arrowPointer, clientX: arrowStartX, buttons: 1 }),
      );
      nav.dispatchEvent(
        new PointerEvent("pointermove", { ...arrowPointer, clientX: arrowStartX - 70, buttons: 1 }),
      );
      nav.dispatchEvent(
        new PointerEvent("pointerup", { ...arrowPointer, clientX: arrowStartX - 70, buttons: 0 }),
      );
      nextButton.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      nextButton.removeEventListener("click", arrowClickSpy);
      await wait(220);
      const afterArrowDrag = title();
      for (let guard = 0; guard < 10 && !prevButton.hasAttribute("disabled"); guard += 1) {
        prevButton.click();
        await wait(120);
      }
      const restoredAfterArrowDrag = title();
      const beforeArrowClick = title();
      nextButton.click();
      await wait(160);
      const afterArrowClick = title();
      prevButton.click();
      await wait(160);
      return {
        groups: document.querySelectorAll("#shots .group").length,
        before,
        after,
        restored: title(),
        afterArrowDrag,
        arrowClickSeen,
        restoredAfterArrowDrag,
        beforeArrowClick,
        afterArrowClick,
        interactive: getComputedStyle(nav.querySelector(".wb-title") || nav).cursor,
      };
    })()`);
    append(`DH_E2E_GROUPNAV ${JSON.stringify(groupNavProbe)}`);
  } catch (error) {
    append(`DH_E2E_GROUPNAV_ERROR ${String(error)}`);
  }
  const handle = win.getNativeWindowHandle();
  append(
    `DH_E2E_CAPTURE ${JSON.stringify({
      platform: process.platform,
      systemVersion: process.getSystemVersion(),
      enabled: state.service.settings.privacy.excludeFromCapture,
      hwnd: process.platform === "win32" ? handle.readBigUInt64LE(0).toString() : null,
    })}`,
  );
  if (process.env.DH_E2E_VOICE === "1") {
    try {
      const voice = await win.webContents.executeJavaScript(`(async () => {
        document.querySelector('[data-tab="voice"]')?.click();
        await new Promise((resolve) => setTimeout(resolve, 120));
        const button = document.querySelector('[data-action="toggle-listen"]');
        if (!(button instanceof HTMLElement)) return { error: "listen button missing" };
        button.click();
        await new Promise((resolve) => setTimeout(resolve, 2600));
        const hintDuring = document.querySelector("#listen-hint")?.textContent?.trim() || "";
        const during = {
          className: button.className,
          pressed: button.getAttribute("aria-pressed"),
          title: button.getAttribute("title"),
        };
        button.click();
        await new Promise((resolve) => setTimeout(resolve, 2600));
        const after = {
          className: button.className,
          pressed: button.getAttribute("aria-pressed"),
          title: button.getAttribute("title"),
        };
        let systemTracks = 0;
        let systemError = "";
        try {
          const stream = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: { width: 1, height: 1 } });
          systemTracks = stream.getAudioTracks().length;
          for (const track of stream.getTracks()) track.stop();
        } catch (error) {
          systemError = String(error);
        }
        const doc = document.documentElement;
        const body = document.body;
        const live = document.querySelector(".voice-live")?.getBoundingClientRect();
        const segments = document.querySelector("#segments")?.getBoundingClientRect();
        const ask = document.querySelector(".voice-live .voice-ask")?.getBoundingClientRect();
        const sideBefore = document.querySelector(".voice-side")?.getBoundingClientRect();
        document.getElementById("btn-voice-answers")?.click();
        await new Promise((resolve) => setTimeout(resolve, 240));
        const side = document.querySelector(".voice-side")?.getBoundingClientRect();
        const answers = document.querySelector("#voice-answers")?.getBoundingClientRect();
        const answerNodes = document.querySelectorAll("#voice-answers .answer");
        const shotsTab = document.querySelector("#tab-shots");
        const voiceVisible = Boolean(
          live &&
            live.width > 0 &&
            live.height > 0 &&
            document.querySelector("#tab-voice")?.classList.contains("active"),
        );
        const shotsHidden = Boolean(shotsTab && getComputedStyle(shotsTab).display === "none");
        const voiceOverflowX = Math.max(0, Math.max(doc.scrollWidth, body.scrollWidth) - window.innerWidth);
        document.getElementById("btn-voice-answers")?.click();
        await new Promise((resolve) => setTimeout(resolve, 120));
        document.querySelector('[data-tab="shots"]')?.click();
        await new Promise((resolve) => setTimeout(resolve, 80));
        return {
          hintDuring,
          during,
          after,
          hintAfter: document.querySelector("#listen-hint")?.textContent?.trim() || "",
          segments: document.querySelectorAll("#segments .segment").length,
          text: document.querySelector("#segments")?.innerText?.trim() || "",
          systemTracks,
          systemError,
          voiceVisible,
          shotsHidden,
          voiceOverflowX,
          voiceLiveWidth: live?.width || 0,
          voiceSideCollapsed: !sideBefore || sideBefore.width === 0,
          voiceSideWidth: side?.width || 0,
          voiceSegmentsHeight: segments?.height || 0,
          voiceAnswersVisible: Boolean(answers && answers.width > 0 && answers.height > 0),
          voiceAnswersWidth: answers?.width || 0,
          voiceAnswersHeight: answers?.height || 0,
          voiceAnswerCount: answerNodes.length,
          voiceAnswerText: document.querySelector("#voice-answers")?.innerText?.trim() || "",
          voiceAskHeight: ask?.height || 0,
        };
      })()`);
      append(`DH_E2E_VOICE_PROBE ${JSON.stringify(voice)}`);
    } catch (error) {
      append(`DH_E2E_VOICE_ERROR ${String(error)}`);
    }
  }
  const shotPath = process.env.DH_E2E_SHOT;
  if (shotPath) {
    try {
      let png: Buffer | null = null;
      let lastError: unknown = null;
      for (let attempt = 0; attempt < 4 && !png; attempt += 1) {
        try {
          png = (await win.webContents.capturePage()).toPNG();
        } catch (error) {
          lastError = error;
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
      }
      if (!png) throw lastError instanceof Error ? lastError : new Error(String(lastError));
      writeFileSync(shotPath, png);
      append("DH_E2E_SHOT_OK");
    } catch (error) {
      append(`DH_E2E_SHOT_ERROR ${String(error)}`);
    }
  }
  const minShotPath = process.env.DH_E2E_MIN_SHOT;
  if (minShotPath) {
    try {
      win.setSize(380, 620);
      await new Promise((resolve) => setTimeout(resolve, 450));
      const layout = await win.webContents.executeJavaScript(`(async () => {
        const doc = document.documentElement;
        const body = document.body;
        const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        const rect = (selector) => document.querySelector(selector)?.getBoundingClientRect() || null;
        const visible = (node) => Boolean(node && node.width > 0 && node.height > 0);
        const nav = rect(".nav-strip");
        const rail = rect(".shot-rail");
        const answer = rect(".answer-pane");
        const workbench = rect(".workbench");
        const compact = {
          mode: "compact",
          innerWidth: window.innerWidth,
          innerHeight: window.innerHeight,
          overflowX: Math.max(0, Math.max(doc.scrollWidth, body.scrollWidth) - window.innerWidth),
          compactClass: body.classList.contains("compact"),
          navVisible: visible(nav),
          navButtons: document.querySelectorAll(".nav-strip [data-tab]").length,
          statusLights: Array.from(document.querySelectorAll("#status-lights .status-light")).map((node) => node.textContent?.trim() || ""),
          footerButtons: Array.from(document.querySelectorAll(".shortcut-bar button")).filter((node) => visible(node.getBoundingClientRect())).length,
          shotActions: Array.from(document.querySelectorAll("#tab-shots .wb-actions > button, #tab-shots .wb-actions > .menu-wrap"))
            .filter((node) => {
              const style = getComputedStyle(node);
              const box = node.getBoundingClientRect();
              return style.display !== "none" && style.visibility !== "hidden" && box.width > 1 && box.height > 1;
            })
            .map((node) => (node.textContent || "").trim()),
          railWidth: rail?.width || 0,
          railHeight: rail?.height || 0,
          answerWidth: answer?.width || 0,
          workbenchHeight: workbench?.height || 0,
          workbenchVisible: visible(workbench),
          stacked: Boolean(rail && answer && answer.top >= rail.bottom - 2),
        };

        document.querySelector('[data-tab="voice"]')?.click();
        await wait(180);
        const live = rect(".voice-live");
        const sideBefore = rect(".voice-side");
        const segments = rect("#segments");
        const ask = rect(".voice-live .voice-ask");
        const voiceBefore = {
          liveVisible: visible(live),
          liveWidth: live?.width || 0,
          sideVisible: visible(sideBefore),
          sideWidth: sideBefore?.width || 0,
          segmentsHeight: segments?.height || 0,
          askHeight: ask?.height || 0,
        };

        document.getElementById("btn-voice-answers")?.click();
        await wait(220);
        const sideOpen = rect(".voice-side");
        const voiceSheet = {
          visible: visible(sideOpen),
          width: sideOpen?.width || 0,
          height: sideOpen?.height || 0,
          top: sideOpen?.top || 0,
          bottom: sideOpen?.bottom || 0,
          overflowX: Math.max(0, Math.max(doc.scrollWidth, body.scrollWidth) - window.innerWidth),
        };
        document.getElementById("btn-voice-answers")?.click();
        await wait(140);

        document.getElementById("btn-expand")?.click();
        await wait(700);
        document.querySelector('[data-tab="shots"]')?.click();
        await wait(180);
        const expandedRail = rect(".shot-rail");
        const expandedAnswer = rect(".answer-pane");
        const expandedNav = rect(".nav-strip");
        const expanded = {
          mode: "expanded",
          innerWidth: window.innerWidth,
          innerHeight: window.innerHeight,
          overflowX: Math.max(0, Math.max(doc.scrollWidth, body.scrollWidth) - window.innerWidth),
          compactClass: body.classList.contains("compact"),
          navVisible: visible(expandedNav),
          railWidth: expandedRail?.width || 0,
          answerWidth: expandedAnswer?.width || 0,
          sideBySide: Boolean(expandedRail && expandedAnswer && expandedAnswer.left >= expandedRail.right - 2),
        };

        document.querySelector('[data-tab="voice"]')?.click();
        await wait(220);
        const voiceLive = rect(".voice-live");
        const voiceSide = rect(".voice-side");
        const expandedVoice = {
          liveWidth: voiceLive?.width || 0,
          sideWidth: voiceSide?.width || 0,
          sideBySide: Boolean(voiceLive && voiceSide && voiceSide.left >= voiceLive.right - 2),
        };

        document.querySelector('[data-tab="shots"]')?.click();
        await wait(160);
        document.getElementById("btn-expand")?.click();
        await wait(600);
        const collapsed = {
          innerWidth: window.innerWidth,
          compactClass: body.classList.contains("compact"),
          overflowX: Math.max(0, Math.max(doc.scrollWidth, body.scrollWidth) - window.innerWidth),
        };

        document.querySelector('[data-tab="more"]')?.click();
        await wait(180);
        document.querySelector('#tab-more [data-action="open-settings"]')?.click();
        await wait(750);
        const settingsAuto = {
          innerWidth: window.innerWidth,
          compactClass: body.classList.contains("compact"),
          visible: document.querySelector("#tab-settings")?.classList.contains("active") || false,
          hotkeySummary: document.querySelector("#hotkey-summary")?.textContent?.trim() || "",
        };
        document.querySelector('[data-tab="shots"]')?.click();
        await wait(650);
        const settingsCollapsed = {
          innerWidth: window.innerWidth,
          compactClass: body.classList.contains("compact"),
        };

        document.querySelector('[data-tab="more"]')?.click();
        await wait(180);
        document.querySelector('#tab-more [data-action="open-knowledge"]')?.click();
        await wait(750);
        const knowledgeAuto = {
          innerWidth: window.innerWidth,
          compactClass: body.classList.contains("compact"),
          visible: document.querySelector("#tab-knowledge")?.classList.contains("active") || false,
        };
        document.querySelector('[data-tab="shots"]')?.click();
        await wait(650);
        const knowledgeCollapsed = {
          innerWidth: window.innerWidth,
          compactClass: body.classList.contains("compact"),
        };

        return {
          compact,
          voiceBefore,
          voiceSheet,
          expanded,
          expandedVoice,
          collapsed,
          settingsAuto,
          settingsCollapsed,
          knowledgeAuto,
          knowledgeCollapsed,
        };
      })()`);
      const png = (await win.webContents.capturePage()).toPNG();
      writeFileSync(minShotPath, png);
      const voiceLayout = await win.webContents.executeJavaScript(`(async () => {
        document.querySelector('[data-tab="voice"]')?.click();
        await new Promise((resolve) => setTimeout(resolve, 160));
        const live = document.querySelector(".voice-live")?.getBoundingClientRect() || null;
        document.getElementById("btn-voice-answers")?.click();
        await new Promise((resolve) => setTimeout(resolve, 200));
        const sheet = document.querySelector(".voice-side")?.getBoundingClientRect() || null;
        return {
          visible: Boolean(live && live.width > 0 && live.height > 0),
          sheetVisible: Boolean(sheet && sheet.width > 0 && sheet.height > 0),
          sheetWidth: sheet?.width || 0,
          sheetHeight: sheet?.height || 0,
        };
      })()`);
      const voiceMinShotPath = process.env.DH_E2E_VOICE_MIN_SHOT;
      if (voiceMinShotPath) {
        const voicePng = (await win.webContents.capturePage()).toPNG();
        writeFileSync(voiceMinShotPath, voicePng);
        append("DH_E2E_VOICE_MIN_SHOT_OK");
      }
      await win.webContents.executeJavaScript(`(async () => {
        document.getElementById("btn-voice-answers")?.click();
        await new Promise((resolve) => setTimeout(resolve, 120));
        document.querySelector('[data-tab="shots"]')?.click();
        await new Promise((resolve) => setTimeout(resolve, 120));
        return true;
      })()`);
      try {
        const hit = await win.webContents.executeJavaScript(`(() => {
          const rect = (selector) => {
            const node = document.querySelector(selector);
            const box = node?.getBoundingClientRect();
            return box ? { x: box.x, y: box.y, width: box.width, height: box.height } : null;
          };
          return {
            innerWidth: window.innerWidth,
            solve: rect("#btn-solve-current"),
            groupSolve: rect("#shots .group .menu-trigger"),
            voiceTab: rect('[data-tab="voice"]'),
            moreTab: rect('[data-tab="more"]'),
          };
        })()`);
        const covers = (rect: { x: number; y: number; width: number; height: number } | null): boolean => {
          if (!rect) return false;
          const x = rect.x + rect.width / 2;
          const y = rect.y + rect.height / 2;
          return overlayHitRegions.some(
            (region) => x >= region.x && x < region.x + region.width && y >= region.y && y < region.y + region.height,
          );
        };
        append(
          `DH_E2E_HIT ${JSON.stringify({
            regions: overlayHitRegions.length,
            innerWidth: hit.innerWidth,
            solve: covers(hit.solve),
            groupSolve: covers(hit.groupSolve),
            voiceTab: covers(hit.voiceTab),
            moreTab: covers(hit.moreTab),
          })}`,
        );
      } catch (error) {
        append(`DH_E2E_HIT_ERROR ${String(error)}`);
      }
      try {
        const settingsProbe = await win.webContents.executeJavaScript(`(async () => {
          const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
          document.querySelector('[data-tab="more"]')?.click();
          await wait(220);
          document.querySelector('#tab-more [data-action="open-settings"]')?.click();
          await wait(700);
          const section = document.querySelector("#tab-settings");
          const node = document.querySelector("#tab-settings .settings-scroll");
          const box = node?.getBoundingClientRect();
          return {
            active: Boolean(section && section.classList.contains("active")),
            rect: box ? { x: box.x, y: box.y, width: box.width, height: box.height } : null,
            scrollHeight: node?.scrollHeight ?? 0,
            clientHeight: node?.clientHeight ?? 0,
            innerWidth: window.innerWidth,
          };
        })()`);
        const rect = settingsProbe.rect;
        const point = rect
          ? { x: Math.round(rect.x + 4), y: Math.round(rect.y + Math.max(2, rect.height / 2)) }
          : null;
        const covered = Boolean(
          point &&
            overlayHitRegions.some(
              (region) =>
                point.x >= region.x &&
                point.x < region.x + region.width &&
                point.y >= region.y &&
                point.y < region.y + region.height,
            ),
        );
        append(
          `DH_E2E_SETTINGS_HIT ${JSON.stringify({
            ...settingsProbe,
            point,
            covered,
            regions: overlayHitRegions.length,
          })}`,
        );
      } catch (error) {
        append(`DH_E2E_SETTINGS_HIT_ERROR ${String(error)}`);
      } finally {
        await win.webContents
          .executeJavaScript(`(async () => {
            document.querySelector('[data-tab="shots"]')?.click();
            await new Promise((resolve) => setTimeout(resolve, 650));
            return true;
          })()`)
          .catch(() => undefined);
      }
      try {
        const solveUi = await win.webContents.executeJavaScript(`(async () => {
          const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
          const button = () => document.querySelector("#btn-solve-current");
          const status = () =>
            document.querySelector("#shots .group.selected .badge, #shots .group .badge")?.textContent?.trim() || "";
          document.querySelector('[data-tab="shots"]')?.click();
          await wait(220);
          const before = button()?.textContent?.trim() || "";
          button()?.click();
          let during = before;
          for (let index = 0; index < 80; index += 1) {
            await wait(50);
            during = button()?.textContent?.trim() || "";
            if (during === "停止") break;
          }
          const statusDuring = status();
          if (during === "停止") button()?.click();
          let recovered = during;
          for (let index = 0; index < 80; index += 1) {
            await wait(50);
            recovered = button()?.textContent?.trim() || "";
            if (recovered !== "停止") break;
          }
          await wait(250);
          return {
            before,
            during,
            statusDuring,
            recovered,
            finalStatus: status(),
            groups: document.querySelectorAll("#shots .group").length,
            enabled: !button()?.disabled,
          };
        })()`);
        append(`DH_E2E_SOLVE ${JSON.stringify(solveUi)}`);
      } catch (error) {
        append(`DH_E2E_SOLVE_ERROR ${String(error)}`);
      }
      try {
        const historyUi = await win.webContents.executeJavaScript(`(async () => {
          const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
          const snapshot = () => window.desktophelper.invoke("app.snapshot");
          const groupId = document.querySelector("#shots .group.selected")?.getAttribute("data-group-id") || "";
          if (!groupId) return { error: "no selected group" };
          const waitForGroup = async (minimumAnswers) => {
            for (let index = 0; index < 160; index += 1) {
              const data = (await snapshot()).data;
              const group = data.groups.find((entry) => entry.id === groupId);
              if (group && group.status !== "answering" && group.answerIds.length >= minimumAnswers) return group;
              await wait(50);
            }
            return null;
          };
          const initial = (await snapshot()).data.groups.find((entry) => entry.id === groupId);
          if (!initial) return { error: "selected group disappeared" };
          const startCount = initial.answerIds.length;
          await window.desktophelper.invoke("screenshot.solve", { groupId });
          if (!(await waitForGroup(startCount + 1))) return { error: "first history solve did not finish" };
          await window.desktophelper.invoke("screenshot.solve", { groupId });
          const solved = await waitForGroup(startCount + 2);
          if (!solved) return { error: "second history solve did not finish" };
          await wait(180);
          const readItems = () => Array.from(document.querySelectorAll("#group-answer .answer-history-item"));
          const card = document.querySelector('#shots [data-group-id="' + groupId + '"]');
          if (!(card instanceof HTMLElement)) return { error: "selected group card is missing" };
          card.click();
          await wait(160);
          const items = readItems();
          const summaries = items.map((item) => item.querySelector(".history-seq")?.textContent?.trim() || "");
          const openBefore = items.filter((item) => item.open).length;
          const latestFirst = items[0]?.classList.contains("latest") || false;
          const olderSummary = items[1]?.querySelector("summary");
          if (olderSummary instanceof HTMLElement) olderSummary.click();
          const olderDetails = olderSummary?.parentElement;
          await wait(160);
          const olderDetailsLive = olderDetails?.isConnected ? readItems()[1] : null;
          const openAfter = readItems().filter((item) => item.open).length;
          const other = Array.from(document.querySelectorAll("#shots .group")).find(
            (entry) => entry.getAttribute("data-group-id") !== groupId,
          );
          if (!(other instanceof HTMLElement)) return { error: "second group card is missing" };
          const otherId = other.getAttribute("data-group-id") || "";
          const otherGroup = (await snapshot()).data.groups.find((entry) => entry.id === otherId);
          const otherCard = document.querySelector('#shots [data-group-id="' + otherId + '"]');
          if (!(otherCard instanceof HTMLElement)) return { error: "second group card went stale" };
          otherCard.click();
          const selectedSync = document.querySelector("#shots .group.selected")?.getAttribute("data-group-id") || "";
          await wait(200);
          const selectedAfter = document.querySelector("#shots .group.selected")?.getAttribute("data-group-id") || "";
          const panelTitle = document.querySelector("#answer-title")?.textContent?.trim() || "";
          const otherHistory = document.querySelectorAll("#group-answer .answer-history-item").length;
          const otherText = document.querySelector("#group-answer")?.textContent?.trim() || "";
          const otherEmptyState = Array.from(document.querySelectorAll("#group-answer .empty")).some((entry) =>
            entry.textContent?.includes("还没有解答"),
          );
          const restoreCard = document.querySelector('#shots [data-group-id="' + groupId + '"]');
          if (restoreCard instanceof HTMLElement) restoreCard.click();
          await wait(180);
          return {
            count: readItems().length,
            answers: solved.answerIds.length,
            groupSeq: solved.seq,
            summaries,
            latestFirst,
            openBefore,
            openAfter,
            olderLiveOpen: olderDetailsLive ? olderDetailsLive.open : null,
            otherId,
            selectedSync,
            otherStored: otherGroup ? otherGroup.answerIds.length : -1,
            otherSeq: otherGroup ? otherGroup.seq : -1,
            selectedAfter,
            panelTitle,
            otherHistory,
            otherEmpty: otherEmptyState,
            restored: document.querySelectorAll("#group-answer .answer-history-item").length,
            restoredSelected: document.querySelector("#shots .group.selected")?.getAttribute("data-group-id") || "",
          };
        })()`);
        append(`DH_E2E_HISTORY ${JSON.stringify(historyUi)}`);
      } catch (error) {
        append(`DH_E2E_HISTORY_ERROR ${String(error)}`);
      }
      append(
        `DH_E2E_MINLAYOUT ${JSON.stringify({ ...layout, voice: voiceLayout, windowOpacity: win.getOpacity() })}`,
      );
    } catch (error) {
      append(`DH_E2E_MINLAYOUT_ERROR ${String(error)}`);
    }
  }
  append("DH_E2E_READY");
  if (process.env.DH_E2E_QUIT === "1") {
    setTimeout(() => app.quit(), 500);
  }
}

async function boot(): Promise<void> {
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }
  await app.whenReady();
  nativeTheme.themeSource = "dark";
  registerAppProtocol();

  electronSession.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    const url = webContents.getURL();
    const trusted = url.startsWith(`${APP_SCHEME}://${APP_HOST}/`);
    callback(
      trusted &&
        (permission === "media" ||
          permission === "display-capture" ||
          permission === "clipboard-read" ||
          permission === "clipboard-sanitized-write"),
    );
  });
  electronSession.defaultSession.setPermissionCheckHandler((webContents, permission) => {
    const url = webContents?.getURL() ?? "";
    const trusted = url.startsWith(`${APP_SCHEME}://${APP_HOST}/`);
    return (
      trusted &&
      (permission === "media" ||
        permission === "display-capture" ||
        permission === "clipboard-read" ||
        permission === "clipboard-sanitized-write")
    );
  });

  registerDisplayMediaHandler();

  const dataDir = app.getPath("userData");
  state.logger = new Logger(dataDir);
  await state.logger.init();
  const secrets = new SecretsStore(join(dataDir, "secrets.json"), state.logger);
  state.service = new AppService({
    dataDir,
    outDir,
    appVersion: app.getVersion(),
    logger: state.logger,
    secrets,
  });
  state.service.setEmitter(broadcast);
  registerIpc();
  await state.service.init();
  state.service.setOverlayBridge(overlayBridge);
  state.service.setHotkeyBridge(hotkeyBridge);
  state.overlay = createOverlayWindow();
  state.settingsCache = state.service.settings;
  createTray();

  app.on("second-instance", () => {
    showOverlay();
  });
  app.on("activate", () => {
    showOverlay();
  });
  state.logger.info("app booted", { version: app.getVersion(), chrome: process.versions.chrome });
  state.logger.info("screen api", {
    screenToDipPoint: typeof (screen as unknown as { screenToDipPoint?: unknown }).screenToDipPoint,
    dipToScreenPoint: typeof (screen as unknown as { dipToScreenPoint?: unknown }).dipToScreenPoint,
    displays: screen.getAllDisplays().map((entry) => ({
      id: String(entry.id),
      bounds: entry.bounds,
      size: entry.size,
      scaleFactor: entry.scaleFactor,
    })),
  });
}

let quitting = false;
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
app.on("before-quit", (event) => {
  if (quitting) return;
  event.preventDefault();
  quitting = true;
  killPointerHelper();
  const finish = () => app.exit(0);
  if (state.service) state.service.shutdown().then(finish).catch(finish);
  else finish();
});
app.on("will-quit", () => {
  killPointerHelper();
  globalShortcut.unregisterAll();
  if (state.tray && !state.tray.isDestroyed()) state.tray.destroy();
  state.tray = null;
});

void boot().catch((error: unknown) => {
  const message = `启动失败：${(error as Error)?.stack ?? String(error)}`;
  try {
    if (process.env.DH_E2E_OUT) appendFileSync(process.env.DH_E2E_OUT, `${message}\n`, "utf8");
  } catch {
    // ignore
  }
  console.error(message);
  app.exit(1);
});
