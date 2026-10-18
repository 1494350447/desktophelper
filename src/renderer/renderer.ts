import { escapeHtml, renderMarkdown } from "../shared/markdown.ts";
import { SpeechSegmenter, float32ToInt16, pcm16ToWav, resampleLinear } from "../shared/audio.ts";
import { shouldMuteMicrophone } from "../shared/echo.ts";
import type {
  Answer,
  AppSettings,
  AppSnapshot,
  CaptureGroup,
  KnowledgeDoc,
  ScreenshotMeta,
  Session,
  Speaker,
  TranscriptSegment,
} from "../shared/models.ts";
import {
  HOTKEY_GROUPS,
  acceleratorFromKeyboard,
  formatAccelerator,
  visibleHotkeyDefinitions,
  type HotkeyActionId,
} from "../shared/hotkeys.ts";
import {
  DASHSCOPE_ASR_LANGUAGE,
  DASHSCOPE_ASR_MODEL,
  DASHSCOPE_HTTP_ENDPOINT,
  DASHSCOPE_HTTP_MODEL,
  DASHSCOPE_REALTIME_BASE_URL,
} from "../shared/models.ts";
import type { IpcError, IpcResult } from "../shared/result.ts";
type Api = {
  version: string;
  platform: string;
  invoke: (channel: string, payload?: unknown) => Promise<IpcResult<unknown>>;
  on: (event: string, listener: (payload: unknown) => void) => () => void;
};
declare global {
  interface Window {
    desktophelper: Api;
  }
}
const api = window.desktophelper;
const $ = <T extends HTMLElement = HTMLElement>(selector: string): T => document.querySelector(selector) as T;
const $$ = <T extends HTMLElement = HTMLElement>(selector: string): T[] =>
  Array.from(document.querySelectorAll(selector));
class UiError extends Error {
  code: string;
  constructor(error: IpcError) {
    super(error.message);
    this.code = error.code;
  }
}
async function invoke<T = unknown>(channel: string, payload?: unknown): Promise<T> {
  const result = await api.invoke(channel, payload);
  if (!result || typeof result !== "object") throw new Error("IPC 返回格式错误");
  if (!result.ok) throw new UiError(result.error);
  return result.data as T;
}
let hitRegionFrame = 0;
/** * Report clickable rectangles to the main process. While click-through is on, * the window only accepts the pointer over these regions (plus the title band * and resize edges), so buttons work without disabling pass-through globally. */ function publishHitRegions(): void {
  if (hitRegionFrame) cancelAnimationFrame(hitRegionFrame);
  hitRegionFrame = requestAnimationFrame(() => {
    hitRegionFrame = 0;
    const regions: Array<{ x: number; y: number; width: number; height: number }> = [];
    const seen = new Set<string>();
    const nodes = document.querySelectorAll<HTMLElement>(
      // Scroll containers must accept the wheel even when the cursor sits on a
      // gap between controls; otherwise click-through forwards it to the window below.
      "button, input, textarea, select, label, a, [data-action], [data-tab], [data-group-id], [data-group-nav], .answer, .segment, .doc, .kb-hit, .queue-item, .menu, .settings-scroll, .more-page, .list, .group-answer, .group-list, .shot-grid, .kb-hits, .group-thumbs, .queue",
    );
    for (const node of nodes) {
      if (node.closest(".hidden")) continue;
      if (node instanceof HTMLInputElement && node.type === "hidden") continue;
      const style = getComputedStyle(node);
      if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) continue;
      const rect = node.getBoundingClientRect();
      const x = Math.max(0, Math.round(rect.left));
      const y = Math.max(0, Math.round(rect.top));
      const right = Math.min(window.innerWidth, Math.round(rect.right));
      const bottom = Math.min(window.innerHeight, Math.round(rect.bottom));
      if (right - x < 2 || bottom - y < 2) continue;
      const key = `${x}:${y}:${right - x}:${bottom - y}`;
      if (seen.has(key)) continue;
      seen.add(key);
      regions.push({ x, y, width: right - x, height: bottom - y });
      if (regions.length >= 600) break;
    }
    void invoke("overlay.hitRegions", { regions }).catch(() => undefined);
  });
}
let interactionActive = false;
let interactionTimer = 0;
let keyboardCapture = false;
let keyboardReleaseTimer = 0;
function setInteractionActive(active: boolean): void {
  interactionActive = active;
  document.body.classList.toggle("interactive", active);
  const focus = document.getElementById("light-focus");
  if (focus) {
    focus.classList.toggle("interacting", active);
    focus.title = active
      ? "防切屏：正在操作浮层，窗口仍保持免激活"
      : "防切屏：浮层为免激活窗口，不抢占考试页焦点";
  }
}
function activateInteraction(): void {
  setInteractionActive(true);
  if (interactionTimer) window.clearTimeout(interactionTimer);
  interactionTimer = window.setTimeout(() => {
    interactionTimer = 0;
    if (!keyboardCapture) setInteractionActive(false);
  }, 1600);
}
function releaseInteraction(): void {
  if (interactionTimer) window.clearTimeout(interactionTimer);
  interactionTimer = 0;
  const active = document.activeElement;
  if (active instanceof HTMLElement && editableElement(active)) active.blur();
  setKeyboardCapture(false);
  setInteractionActive(false);
}
function editableElement(target: EventTarget | null): HTMLElement | null {
  const element = target instanceof HTMLElement ? target : null;
  if (!element || typeof element.closest !== "function") return null;
  const editable = element.closest<HTMLElement>("input, textarea, select, [contenteditable='true']");
  if (!editable) return null;
  if (editable instanceof HTMLInputElement && editable.type === "hidden") return null;
  return editable;
}
/** * The overlay is intentionally non-activating (WS_EX_NOACTIVATE), so buttons * never steal focus from the exam page. Text fields are the only exception: * they ask the main process for real keyboard focus while they are being * edited, then hand focus back on blur or Escape. */ function setKeyboardCapture(
  active: boolean,
): void {
  if (keyboardCapture === active) return;
  keyboardCapture = active;
  if (keyboardReleaseTimer) {
    window.clearTimeout(keyboardReleaseTimer);
    keyboardReleaseTimer = 0;
  }
  if (active) setInteractionActive(true);
  void invoke("overlay.keyboard", { active }).catch(() => {
    keyboardCapture = !active;
  });
}
let snapshot: AppSnapshot | null = null;
let activeTab: "shots" | "voice" | "knowledge" | "settings" | "more" = "shots";
let settingsDirty = false;
let lastSettingsJson = "";
let selectedGroupId: string | null = null;
let uiScale = 1;
const openHistoryAnswers = new Set<string>();
const thumbs = new Map<string, string>();
const pendingThumbs = new Set<string>();
const streamingText = new Map<string, string>();
const recorders = new Map<
  "mic" | "system",
  { stop: (options?: { immediate?: boolean }) => Promise<void>; mute: () => void }
>();
const recorderStarts = new Set<"mic" | "system">();
const sendQueues = new Map<"mic" | "system", Promise<void>>();
const realtimePartials = new Map<"mic" | "system", string>();
const channelAudioLevels: Record<"mic" | "system", number> = { mic: 0, system: 0 };
const channelLevelsAt: Record<"mic" | "system", number> = { mic: 0, system: 0 };
let lastSystemLevel = 0;
let systemActiveAt = 0;
let kbHits: Array<{ docName: string; text: string; score: number }> = [];
let unlockError = "";
let listenTransition = false;
let autoExpanded = false;
let layoutBusy = false;
let visualCompact = true;
let layoutInitialized = false;
let pendingLayout: { compact: boolean; persist: boolean } | null = null;
function toast(level: "info" | "success" | "warn" | "error", message: string): void {
  const host = $("#toasts");
  const node = document.createElement("div");
  node.className = `toast ${level}`;
  node.textContent = message;
  host.appendChild(node);
  setTimeout(() => node.remove(), 4200);
}
function rmsLevel(samples: Float32Array): number {
  let sum = 0;
  for (const sample of samples) sum += sample * sample;
  return Math.sqrt(sum / Math.max(1, samples.length));
}
function updateChannelLevel(channel: "mic" | "system", level: number): void {
  channelAudioLevels[channel] = Math.max(level, channelAudioLevels[channel] * 0.82);
  channelLevelsAt[channel] = performance.now();
  if (channel === "system") {
    lastSystemLevel = level;
    if (level >= 0.008) systemActiveAt = channelLevelsAt[channel];
  }
}
/** * When system audio is clearly dominant, microphone energy is usually speaker * leakage. Keep the microphone open for near-field speech so simultaneous * local talk is still attributed to "me". */ function isMicrophoneEcho(
  micLevel: number,
): boolean {
  return shouldMuteMicrophone({
    micLevel,
    systemLevel: lastSystemLevel,
    systemActiveAt,
    now: performance.now(),
  });
}
function reportError(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  toast("error", message);
}
function formatTime(timestamp: number): string {
  const date = new Date(timestamp);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}
const STATUS_LABEL: Record<Answer["status"], string> = {
  streaming: "生成中",
  done: "完成",
  error: "失败",
  cancelled: "已取消",
};
const ANSWER_STATUS_CLASS: Record<Answer["status"], string> = {
  streaming: "warn",
  done: "ok",
  error: "err",
  cancelled: "",
};
const TRIGGER_LABEL: Record<Answer["trigger"], string> = {
  auto: "自动",
  manual: "手动",
  queue: "队列",
  screenshot: "截图",
  knowledge: "知识库",
};
const ARCHIVE_LABEL: Record<ScreenshotMeta["archiveState"], string> = {
  pending: "待归档",
  archived: "已归档",
  failed: "归档失败",
};
const STAGE_LABEL: Record<string, string> = {
  idle: "未分析",
  queued: "排队中",
  extracting: "提取题面中",
  solving: "解题中",
  done: "已完成",
  error: "失败",
  cancelled: "已取消",
};
const GROUP_STATUS_LABEL: Record<CaptureGroup["status"], string> = {
  collecting: "采集中",
  answering: "解题中",
  answered: "已解答",
  error: "上次失败",
  closed: "已结束",
};
const GROUP_STATUS_CLASS: Record<CaptureGroup["status"], string> = {
  collecting: "warn",
  answering: "",
  answered: "ok",
  error: "err",
  closed: "",
};
const GROUP_MAIN_ACTION: Record<CaptureGroup["status"], { action: string; label: string }> = {
  collecting: { action: "group-solve", label: "解题" },
  answering: { action: "group-stop", label: "停止" },
  answered: { action: "group-solve", label: "重新解题" },
  error: { action: "group-retry", label: "重试" },
  closed: { action: "group-reopen", label: "补图" },
};
function closeMenus(): void {
  $$(".menu-wrap.open").forEach((node) => node.classList.remove("open"));
  publishHitRegions();
}
function toggleMenu(node: HTMLElement): void {
  const wrap = node.closest<HTMLElement>(".menu-wrap");
  if (!wrap) return;
  const wasOpen = wrap.classList.contains("open");
  closeMenus();
  if (!wasOpen) wrap.classList.add("open");
  publishHitRegions();
}
function findGroupAnswer(group: CaptureGroup): Answer | null {
  const answers = snapshot?.session.answers ?? [];
  if (group.answerId) {
    const current = answers.find((answer) => answer.id === group.answerId);
    if (current) return current;
  }
  for (let index = group.answerIds.length - 1; index >= 0; index -= 1) {
    const answer = answers.find((entry) => entry.id === group.answerIds[index]);
    if (answer) return answer;
  }
  return (
    answers
      .filter((answer) => answer.groupId === group.id)
      .sort((left, right) => right.createdAt - left.createdAt)[0] ?? null
  );
}
function groupAnswerHistory(group: CaptureGroup): Answer[] {
  const answers = snapshot?.session.answers ?? [];
  const ids = [...group.answerIds];
  if (group.answerId && !ids.includes(group.answerId)) ids.push(group.answerId);
  const history: Answer[] = [];
  const seen = new Set<string>();
  const add = (answer: Answer | undefined) => {
    if (!answer || seen.has(answer.id)) return;
    seen.add(answer.id);
    history.push(answer);
  };
  for (const id of ids) add(answers.find((answer) => answer.id === id));
  for (const answer of answers) {
    if (answer.groupId === group.id) add(answer);
  }
  return history.sort((left, right) => left.createdAt - right.createdAt);
}
function visibleGroups(): CaptureGroup[] {
  if (!snapshot) return [];
  return snapshot.groups
    .filter((group) => group.sessionId === snapshot!.session.id && group.screenshotIds.length > 0)
    .slice()
    .sort((left, right) => right.createdAt - left.createdAt);
}
function currentGroup(): CaptureGroup | null {
  const groups = visibleGroups();
  if (groups.length === 0) return null;
  return groups.find((group) => group.id === selectedGroupId) ?? groups[0];
}
function selectGroup(groupId: string | null): void {
  selectedGroupId = groupId;
  renderShots();
}
function applyUiScale(scale: number): void {
  uiScale = Math.max(0.8, Math.min(1.4, Math.round(scale * 10) / 10));
  document.body.style.zoom = String(uiScale);
  try {
    localStorage.setItem("dh-ui-scale", String(uiScale));
  } catch {
    // ignore storage failures
  }
}
function compactLayoutEnabled(): boolean {
  return visualCompact;
}
function applyLayout(compact: boolean): void {
  visualCompact = compact;
  document.body.classList.toggle("compact", compact);
  document.body.classList.toggle("expanded", !compact);
  const expand = document.getElementById("btn-expand");
  if (expand) {
    const label = compact ? "展开工作区" : "收起为单栏";
    expand.textContent = compact ? "⤢" : "⤡";
    expand.title = label;
    expand.setAttribute("aria-label", label);
  }
}
async function setCompactLayout(compact: boolean, persist = true): Promise<void> {
  if (!snapshot) return;
  if (layoutBusy) {
    pendingLayout = { compact, persist };
    return;
  }
  layoutBusy = true;
  try {
    if (persist && snapshot.settings.overlay.compact !== compact) {
      snapshot = await invoke<AppSnapshot>("overlay.update", { compact });
    }
    applyLayout(compact);
    await invoke("overlay.layout", { compact });
    render();
  } finally {
    layoutBusy = false;
    const next = pendingLayout;
    pendingLayout = null;
    if (next && next.compact !== visualCompact) void setCompactLayout(next.compact, next.persist);
  }
}
function syncVoiceAnswersToggle(): void {
  const side = document.querySelector(".voice-side");
  const open = Boolean(side?.classList.contains("open"));
  const button = document.getElementById("btn-voice-answers");
  if (!button) return;
  button.classList.toggle("active", open);
  button.title = open ? "收起回答记录" : "展开回答记录";
}
function scrollAnswer(delta: number): void {
  document.getElementById("group-answer")?.scrollBy({ top: delta, behavior: "smooth" });
}
function stepGroup(direction: -1 | 1): void {
  const groups = visibleGroups();
  if (groups.length === 0) return;
  const index = Math.max(
    0,
    groups.findIndex((group) => group.id === (currentGroup()?.id ?? "")),
  );
  const next = Math.max(0, Math.min(groups.length - 1, index + direction));
  selectedGroupId = groups[next].id;
  renderShots();
  document
    .querySelector(`#shots [data-group-id="${selectedGroupId}"]`)
    ?.scrollIntoView({ block: "nearest", inline: "center" });
}
async function solveCurrentGroup(): Promise<void> {
  const group = currentGroup();
  if (!group) {
    await invoke("screenshot.captureRegion");
    return;
  }
  if (group.status === "answering") {
    await invoke("screenshot.stopGroup", { groupId: group.id });
  } else if (group.status === "error") {
    await invoke("screenshot.retry", { groupId: group.id });
  } else if (group.status === "closed") {
    await invoke("screenshot.reopen", { groupId: group.id });
  } else {
    await invoke("screenshot.solve", { groupId: group.id });
  }
  await refresh();
}
async function deleteLastShot(): Promise<void> {
  const group = currentGroup();
  const shotId = group?.screenshotIds[group.screenshotIds.length - 1];
  if (!shotId) {
    toast("warn", "当前组没有可删除的截图");
    return;
  }
  await invoke("screenshot.delete", { id: shotId });
  thumbs.delete(shotId);
  await refresh();
  toast("info", "已删除最后一张截图");
}
async function answerLatestSegment(speaker: Speaker): Promise<void> {
  const segment = [...(snapshot?.session.segments ?? [])]
    .reverse()
    .find((entry) => entry.speaker === speaker);
  if (!segment) {
    toast("warn", speaker === "interviewer" ? "还没有识别到对方的发言" : "还没有识别到你的发言");
    return;
  }
  await invoke("answer.start", { question: segment.text, trigger: "manual" });
  switchTab("voice");
  await refresh();
}
async function copyText(text: string): Promise<void> {
  if (!text.trim()) throw new Error("没有可复制的内容"); // A non-activating window may not satisfy the browser clipboard focus
  // requirement, so copy through the main process first.
  try {
    await invoke("system.copyText", { text });
    return;
  } catch {
    // Fall through to the web clipboard on a non-Electron host.
  }
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const area = document.createElement("textarea");
  area.value = text;
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.appendChild(area);
  area.select();
  document.execCommand("copy");
  area.remove();
}
function switchTab(tab: typeof activeTab): void {
  if (document.activeElement instanceof HTMLElement && editableElement(document.activeElement)) {
    document.activeElement.blur();
  }
  setKeyboardCapture(false);
  activeTab = tab;
  document.body.dataset.activeTab = tab;
  const navTab = tab === "settings" || tab === "knowledge" ? "more" : tab;
  $$(".nav-strip [data-tab]").forEach((button) =>
    button.classList.toggle("active", button.dataset.tab === navTab),
  );
  $$(".tab").forEach((section) => section.classList.toggle("active", section.id === `tab-${tab}`));
  const wantsWide = tab === "settings";
  if (wantsWide && compactLayoutEnabled()) {
    autoExpanded = true;
    void setCompactLayout(false, false).catch(reportError);
  } else if (!wantsWide && autoExpanded) {
    autoExpanded = false;
    void setCompactLayout(true, false).catch(reportError);
  }
  if (tab === "shots") renderShots();
  if (tab === "more") renderShortcutBar();
  if (tab === "voice") {
    renderSegments();
    renderAnswers();
    renderQueue();
    syncVoiceAnswersToggle();
  }
  if (tab === "knowledge") void refresh();
  if (tab === "settings") renderSettings(true);
  if (tab === "settings") void refreshHotkeyStatus();
  publishHitRegions();
}
function bindEvents(): void {
  api.on("state", (payload) => {
    snapshot = payload as AppSnapshot;
    render();
  });
  api.on("answer.delta", (payload) => {
    const data = payload as { answerId: string; delta: string };
    const elements = document.querySelectorAll<HTMLElement>(`[data-answer-text="${data.answerId}"]`);
    if (elements.length === 0) return;
    const current = streamingText.get(data.answerId) ?? "";
    const next = current + data.delta;
    streamingText.set(data.answerId, next);
    for (const element of elements) {
      element.textContent = next;
      element.scrollIntoView({ block: "nearest" });
    }
  });
  api.on("answer.reset", (payload) => {
    const data = payload as { answerId: string };
    streamingText.delete(data.answerId);
    document.querySelectorAll<HTMLElement>(`[data-answer-text="${data.answerId}"]`).forEach((element) => {
      element.textContent = "";
    });
  });
  api.on("answer.done", () => void refresh());
  api.on("answer.error", (payload) => {
    const data = payload as { message: string; cancelled: boolean };
    if (!data.cancelled) toast("error", data.message);
    void refresh();
  });
  api.on("toast", (payload) => {
    const data = payload as { level: "info" | "success" | "warn" | "error"; message: string };
    toast(data.level, data.message);
  });
  api.on("screenshot", (payload) => {
    const data = payload as { meta: ScreenshotMeta; dataUrl: string };
    thumbs.set(data.meta.id, data.dataUrl);
    toast("success", "截图已保存");
    void refresh().then(() => {
      const group = snapshot?.groups.find((entry) => entry.screenshotIds.includes(data.meta.id));
      if (group) {
        selectedGroupId = group.id;
        if (activeTab === "shots") renderShots();
      }
    });
  });
  api.on("screenshot.stage", (payload) => {
    const data = payload as { stage: string; message?: string };
    if (data.message) toast("info", data.message);
    void refresh();
  });
  document.addEventListener("click", (event) => {
    const summary = (event.target as HTMLElement).closest("summary");
    const details = summary?.parentElement;
    if (!(details instanceof HTMLDetailsElement)) return;
    const answerId = details.dataset.historyAnswer;
    if (!answerId) return;
    if (details.open) openHistoryAnswers.delete(answerId);
    else openHistoryAnswers.add(answerId);
  });
  api.on("transcribe.status", (payload) => {
    const data = payload as { channel: string; state: string; message?: string };
    const label = data.channel === "mic" ? "麦克风" : "系统声音";
    if (data.state === "error") {
      realtimePartials.delete(data.channel as "mic" | "system");
      renderSegments();
      toast("error", `${label}：${data.message ?? "转写失败"}`);
    }
    if (data.state === "connecting") $("#listen-hint").textContent = `${label}连接实时识别…`;
    if (data.state === "listening") $("#listen-hint").textContent = `${label}实时识别中…`;
    if (data.state === "transcribing") $("#listen-hint").textContent = `${label}识别中…`;
    if (data.state === "done" || data.state === "idle") {
      realtimePartials.delete(data.channel as "mic" | "system");
      renderSegments();
      updateListenHint();
    }
  });
  api.on("transcribe.partial", (payload) => {
    const data = payload as { channel: "mic" | "system"; text: string };
    const text = data.text.trim();
    if (text) realtimePartials.set(data.channel, text);
    else realtimePartials.delete(data.channel);
    renderSegments();
  });
  api.on("command", (payload) => {
    const data = payload as { type: string; delta?: number; reset?: boolean };
    switch (data.type) {
      case "toggle-listening":
        void toggleListening();
        break;
      case "focus-ask":
        $("#ask-input").focus();
        break;
      case "show-settings":
        switchTab("settings");
        break;
      case "emergency-hide":
        void emergencyHide().catch(reportError);
        break;
      case "solve-group":
        void solveCurrentGroup().catch(reportError);
        break;
      case "toggle-knowledge":
        switchTab(activeTab === "knowledge" ? "shots" : "knowledge");
        break;
      case "reset-view":
        applyUiScale(1);
        switchTab("shots");
        document.getElementById("group-answer")?.scrollTo({ top: 0 });
        break;
      case "zoom":
        applyUiScale(typeof data.delta === "number" && data.delta !== 0 ? uiScale + data.delta : 1);
        break;
      case "delete-last-shot":
        void deleteLastShot().catch(reportError);
        break;
      case "answer-question":
        void answerLatestSegment("interviewer").catch(reportError);
        break;
      case "voice-solve":
        void answerLatestSegment("me").catch(reportError);
        break;
      case "page-prev":
        stepGroup(-1);
        break;
      case "page-next":
        stepGroup(1);
        break;
      case "scroll-up":
        scrollAnswer(-240);
        break;
      case "scroll-down":
        scrollAnswer(240);
        break;
      default:
        break;
    }
  });
}
function render(): void {
  if (!snapshot) return;
  const settings = snapshot.settings;
  document.documentElement.style.setProperty("--font", `${settings.overlay.fontSize}px`);
  if (!layoutInitialized) {
    layoutInitialized = true;
    visualCompact = settings.overlay.compact;
  }
  applyLayout(visualCompact);
  $("#version").textContent = `v${snapshot.appVersion}`;
  $("#data-dir").textContent = snapshot.dataDir;
  updateStatusLights();
  updateListenHint();
  renderShortcutBar();
  renderLock();
  if (snapshot.lock.enabled && !snapshot.lock.unlocked) return;
  renderSegments();
  renderAnswers();
  renderQueue();
  if (activeTab === "shots") renderShots();
  if (activeTab === "knowledge") renderKnowledge();
  if (activeTab === "settings") renderSettings();
  publishHitRegions();
}
function updateListenHint(): void {
  if (!snapshot) return;
  const parts: string[] = [];
  if (snapshot.listening.mic) parts.push("麦克风");
  if (snapshot.listening.system) parts.push("系统声音");
  $("#listen-hint").textContent = parts.length ? `收音中：${parts.join(" + ")}` : "未收音";
  updateListenButton(parts.length > 0 || listenTransition);
  document.getElementById("led-mic")?.classList.toggle("on", snapshot.listening.mic);
  document.getElementById("led-system")?.classList.toggle("on", snapshot.listening.system);
  updateStatusLights();
}
function updateStatusLights(): void {
  if (!snapshot) return;
  const focus = document.getElementById("light-focus");
  const capture = document.getElementById("light-capture");
  const focusOk = Boolean(snapshot.settings.overlay.clickThrough) || interactionActive;
  const captureOk = Boolean(snapshot.settings.privacy.excludeFromCapture);
  focus?.classList.toggle("on", focusOk);
  focus?.classList.toggle("off", !focusOk);
  capture?.classList.toggle("on", captureOk);
  capture?.classList.toggle("off", !captureOk);
}
function renderShortcutBar(): void {
  if (!snapshot) return;
  const hotkeys = snapshot.settings.hotkeys;
  const bind = (id: string, accelerator: string) => {
    const element = document.getElementById(id);
    if (element) element.textContent = formatAccelerator(accelerator, api.platform) || "未绑定";
  };
  bind("shortcut-capture", hotkeys.captureRegion);
  bind("shortcut-solve", hotkeys.solveGroup);
  bind("shortcut-listen", hotkeys.toggleListening);
  const emergency = document.getElementById("emergency-hotkey");
  if (emergency) emergency.textContent = formatAccelerator(hotkeys.emergencyHide, api.platform) || "未绑定";
}
function updateListenButton(active: boolean): void {
  const button = document.getElementById("btn-listen");
  if (!button) return;
  button.classList.toggle("recording", active);
  button.classList.toggle("idle", !active);
  button.setAttribute("aria-pressed", active ? "true" : "false");
  const label = active ? "暂停收音" : "开始收音";
  button.title = label;
  button.setAttribute("aria-label", label);
}
function renderSegments(): void {
  const host = $("#segments");
  if (!snapshot) return;
  const session = snapshot!.session;
  const partials = [...realtimePartials.entries()].filter(([, text]) => text.trim().length > 0);
  if (session.segments.length === 0 && partials.length === 0) {
    host.innerHTML = `<div class="empty">还没有转写内容。点击顶部 ◉ 开始收音，或在下方手动提问。</div>`;
    return;
  }
  const rows = session.segments.slice(-200).map((segment) => {
    const label = segment.speaker === "me" ? "我" : "对方";
    return `<div class="segment" data-segment-row="${segment.id}">        <span class="time">${formatTime(segment.createdAt)}</span>        <div class="body">          <span class="chip ${segment.speaker}" data-speaker-toggle="${segment.id}" title="点击切换说话人">${label}</span>          <div class="text">${escapeHtml(segment.text)}</div>        </div>      </div>`;
  });
  for (const [channel, text] of partials) {
    const speaker =
      channel === "mic" ? snapshot.settings.voice.micSpeaker : snapshot.settings.voice.systemSpeaker;
    const label = speaker === "me" ? "我" : "对方";
    rows.push(
      `<div class="segment partial">        <span class="time">现在</span>        <div class="body">          <span class="chip ${speaker}">${label}</span>          <div class="text">${escapeHtml(text)}…</div>        </div>      </div>`,
    );
  }
  host.innerHTML = rows.join("");
  host.scrollTop = host.scrollHeight;
}
function answerHtml(answer: Answer, embedded = false): string {
  const body =
    answer.status === "streaming"
      ? `<div class="answer-text" data-answer-text="${answer.id}">${escapeHtml(answer.text)}</div>`
      : `<div class="answer-text" data-answer-text="${answer.id}">${renderMarkdown(answer.text || "（无内容）")}</div>`;
  const actions: string[] = [];
  if (!embedded) {
    if (answer.status === "streaming") {
      actions.push(`<button data-action="answer-cancel" data-id="${answer.id}">取消</button>`);
    } else {
      actions.push(`<button data-action="answer-retry" data-id="${answer.id}">重试</button>`);
    }
  }
  const metaParts = [
    STATUS_LABEL[answer.status],
    TRIGGER_LABEL[answer.trigger],
    answer.model ? answer.model : "",
    answer.screenshotIds?.length
      ? `${answer.screenshotIds.length} 张截图`
      : answer.screenshotId
        ? "含截图"
        : "",
  ].filter(Boolean);
  const error = answer.error ? `<div class="error">${escapeHtml(answer.error)}</div>` : "";
  const cited =
    answer.citedDocs && answer.citedDocs.length
      ? `<div class="meta">引用资料：${answer.citedDocs.map((name) => escapeHtml(name)).join("、")}</div>`
      : "";
  return `<div class="answer ${answer.status}${embedded ? " embedded" : ""}" data-answer-id="${answer.id}">    <div class="answer-head">      <span>${formatTime(answer.createdAt)}</span>      <span>${metaParts.join(" · ")}</span>      <span class="spacer"></span>      ${actions.join("")}    </div>    ${answer.trigger === "screenshot" ? "" : `<div class="question">${escapeHtml(answer.question)}</div>`}    ${body}    ${error}    ${cited}  </div>`;
}
function renderAnswers(): void {
  const allAnswers = snapshot!.session.answers;
  const answers = allAnswers.filter((answer) => !answer.groupId && answer.trigger !== "screenshot");
  streamingText.clear();
  for (const answer of allAnswers) {
    if (answer.status === "streaming") streamingText.set(answer.id, answer.text);
  }
  const html =
    answers.length === 0
      ? `<div class="empty">还没有回答。对方提出问题后会自动触发生成。</div>`
      : answers
          .slice()
          .reverse()
          .map((answer) => answerHtml(answer))
          .join("");
  const host = document.getElementById("voice-answers");
  if (host) host.innerHTML = html;
  const model = `${snapshot!.settings.llm.provider === "mock" ? "演示模型" : snapshot!.settings.llm.model}`;
  const voiceModel = document.getElementById("voice-model-hint");
  if (voiceModel) voiceModel.textContent = model;
  const count = answers.length ? String(answers.length) : "";
  const answerCount = document.getElementById("voice-answer-count");
  if (answerCount) answerCount.textContent = count;
  const navCount = document.getElementById("nav-voice-count");
  if (navCount) navCount.textContent = count;
  syncVoiceAnswersToggle();
}
function renderQueue(): void {
  const host = $("#queue");
  const queue = snapshot!.session.queue.filter((item) => (item.lane ?? "voice") === "voice");
  $("#queue-count").textContent = queue.length ? `${queue.length} 个待答问题` : "";
  const wrap = document.getElementById("voice-queue-wrap");
  if (wrap) wrap.hidden = queue.length === 0;
  if (queue.length === 0) {
    host.innerHTML = "";
    return;
  }
  host.innerHTML =
    queue
      .map(
        (item) =>
          `<div class="queue-item" title="${escapeHtml(item.text)}">          <span>${escapeHtml(item.text.slice(0, 24))}</span>          <button data-action="queue-remove" data-id="${item.id}">×</button>        </div>`,
      )
      .join("") +
    `<div class="queue-item"><button data-action="queue-next">下一条</button><button data-action="queue-clear">清空</button></div>`;
}
function ensureThumb(meta: ScreenshotMeta): void {
  if (thumbs.has(meta.id) || pendingThumbs.has(meta.id)) return;
  pendingThumbs.add(meta.id);
  void invoke<{ dataUrl: string }>("screenshot.read", { id: meta.id })
    .then((data) => {
      thumbs.set(meta.id, data.dataUrl);
      const image = document.querySelector<HTMLImageElement>(`[data-thumb="${meta.id}"]`);
      if (image) {
        image.src = data.dataUrl;
        image.classList.remove("hidden");
        image.parentElement?.querySelector(".thumb-fallback")?.classList.add("hidden");
      }
    })
    .catch(() => undefined)
    .finally(() => pendingThumbs.delete(meta.id));
}
function renderShots(): void {
  const host = $("#shots");
  const groups = visibleGroups();
  if (groups.length === 0) {
    selectedGroupId = null;
    host.innerHTML = `<div class="empty">还没有截图。<br />按 <kbd>Ctrl+H</kbd> 框选题目，连续截图会自动加入当前组。</div>`;
    $("#group-position").textContent = "还没有截图";
    const emptyPrev = document.getElementById("group-prev") as HTMLButtonElement | null;
    const emptyNext = document.getElementById("group-next") as HTMLButtonElement | null;
    if (emptyPrev) emptyPrev.disabled = true;
    if (emptyNext) emptyNext.disabled = true;
    $("#group-count").textContent = "0 组";
    const navCount = document.getElementById("nav-shots-count");
    if (navCount) navCount.textContent = "";
    $("#shots-summary").textContent = "连续截图自动加入当前组；重新截图会新建一组";
    const solveButton = document.getElementById("btn-solve-current") as HTMLButtonElement | null;
    if (solveButton) {
      solveButton.textContent = "截图";
      solveButton.disabled = false;
      solveButton.title = "框选题目（Ctrl+H）";
    }
    const deleteButton = document.getElementById("btn-delete-last") as HTMLButtonElement | null;
    if (deleteButton) deleteButton.disabled = true;
    renderCurrentAnswer();
    return;
  }
  if (!selectedGroupId || !groups.some((group) => group.id === selectedGroupId)) {
    selectedGroupId = groups[0].id;
  }
  const byId = new Map(snapshot!.screenshots.map((meta) => [meta.id, meta]));
  host.innerHTML = groups
    .map((group, index) => {
      const shots = group.screenshotIds
        .map((shotId) => byId.get(shotId))
        .filter((meta): meta is ScreenshotMeta => Boolean(meta));
      if (shots.length === 0) return "";
      const answer = findGroupAnswer(group);
      const historyCount = groupAnswerHistory(group).length;
      const archiveFailed = shots.some((meta) => meta.archiveState === "failed");
      const main = GROUP_MAIN_ACTION[group.status];
      const stopAnswerId = answer?.id ?? group.answerId ?? "";
      const mainButton = `<button class="${group.status === "answering" ? "danger" : "primary"}" data-action="${main.action}" data-id="${group.id}"${main.action === "group-stop" ? ` data-answer-id="${stopAnswerId}"` : ""}>${main.label}</button>`;
      const thumbsHtml = shots
        .map((meta) => {
          const thumb = thumbs.get(meta.id);
          const archiveClass =
            meta.archiveState === "archived" ? "ok" : meta.archiveState === "failed" ? "err" : "pending";
          return `<figure class="group-thumb ${archiveClass}" title="${ARCHIVE_LABEL[meta.archiveState]} · ${meta.width}×${meta.height}">            <img data-thumb="${meta.id}" class="${thumb ? "" : "hidden"}" ${thumb ? `src="${thumb}"` : ""} alt="" />            <span class="thumb-fallback">${meta.width}×${meta.height}</span>            <span class="thumb-tag">${meta.mode === "region" ? "区域" : "全屏"}</span>            <button class="thumb-delete" data-action="shot-delete" data-id="${meta.id}" title="删除这张截图"${group.status === "answering" ? " disabled" : ""}>×</button>          </figure>`;
        })
        .join("");
      return `<article class="group${group.id === selectedGroupId ? " selected" : ""}" data-group-id="${group.id}" data-group-index="${index}">        <header class="group-head">          <div class="group-title">            <span class="group-name">第 ${group.seq} 组</span>            <span class="hint">${formatTime(group.createdAt)}</span>            <span class="hint">${shots.length} 张</span>            <span class="badge ${GROUP_STATUS_CLASS[group.status]}">${GROUP_STATUS_LABEL[group.status]}</span>            ${historyCount > 1 ? `<span class="badge history-count" title="共 ${historyCount} 次解答记录">${historyCount} 次</span>` : ""}            ${archiveFailed ? `<span class="badge err" title="后台会自动重试归档">归档失败</span>` : ""}          </div>          <div class="group-actions">            ${mainButton}            <div class="menu-wrap">              <button class="menu-trigger" data-action="group-menu" data-id="${group.id}" title="更多操作">⋯</button>              <div class="menu">                <button data-action="group-reopen" data-id="${group.id}" ${group.status === "answering" ? "disabled" : ""}>补图</button>                <button data-action="group-extract" data-id="${group.id}" ${group.status === "answering" ? "disabled" : ""}>只提取题面</button>                <button data-action="group-close" data-id="${group.id}" ${group.status === "answering" || group.status === "closed" ? "disabled" : ""}>结束本组</button>                <button data-action="group-copy" data-id="${group.id}" ${answer?.text ? "" : "disabled"}>复制解答</button>                <button data-action="group-delete" data-id="${group.id}" class="danger" ${group.status === "answering" ? "disabled" : ""}>删除本组</button>              </div>            </div>          </div>        </header>        <div class="group-thumbs">${thumbsHtml}</div>      </article>`;
    })
    .join("");
  const activeGroup = groups.find((group) => group.id === selectedGroupId) ?? groups[0];
  const activeIndex = Math.max(
    0,
    groups.findIndex((group) => group.id === activeGroup.id),
  );
  const activeShots = activeGroup.screenshotIds
    .map((shotId) => byId.get(shotId))
    .filter((meta): meta is ScreenshotMeta => Boolean(meta));
  $("#group-position").textContent = `第 ${activeGroup.seq} 组 · ${activeIndex + 1} / ${groups.length}`;
  const prevButton = document.getElementById("group-prev") as HTMLButtonElement | null;
  const nextButton = document.getElementById("group-next") as HTMLButtonElement | null;
  if (prevButton) prevButton.disabled = activeIndex <= 0;
  if (nextButton) nextButton.disabled = activeIndex >= groups.length - 1;
  $("#group-count").textContent = `${groups.length} 组`;
  const navCount = document.getElementById("nav-shots-count");
  if (navCount) navCount.textContent = String(groups.length);
  $("#shots-summary").textContent =
    activeGroup.status === "collecting"
      ? "连续截图会加入本组；点“解题”后锁定本组"
      : `${activeShots.length} 张截图 · ${GROUP_STATUS_LABEL[activeGroup.status]}`;
  const solveButton = document.getElementById("btn-solve-current") as HTMLButtonElement | null;
  if (solveButton) {
    const main = GROUP_MAIN_ACTION[activeGroup.status];
    solveButton.textContent = main.label;
    solveButton.disabled = false;
    solveButton.title = `${main.label}（Ctrl+Enter）`;
  }
  const deleteButton = document.getElementById("btn-delete-last") as HTMLButtonElement | null;
  if (deleteButton) deleteButton.disabled = activeGroup.status === "answering" || activeShots.length === 0;
  renderCurrentAnswer();
  for (const meta of activeShots) ensureThumb(meta);
}
function renderCurrentAnswer(): void {
  const host = document.getElementById("group-answer");
  if (!host) return;
  const group = currentGroup();
  const title = document.getElementById("answer-title");
  const meta = document.getElementById("answer-meta");
  if (!group) {
    if (title) title.textContent = "解答";
    if (meta) meta.textContent = "";
    host.innerHTML = `<div class="empty">截图完成后，按 <kbd>Ctrl+Enter</kbd> 或点击“解题”，解答会显示在这里。</div>`;
    return;
  }
  const byId = new Map(snapshot!.screenshots.map((item) => [item.id, item]));
  const shots = group.screenshotIds
    .map((shotId) => byId.get(shotId))
    .filter((entry): entry is ScreenshotMeta => Boolean(entry));
  const answer = findGroupAnswer(group);
  const history = groupAnswerHistory(group);
  const extracted = shots
    .map((entry) => entry.analysis.extracted)
    .filter((entry): entry is NonNullable<ScreenshotMeta["analysis"]["extracted"]> => Boolean(entry))
    .at(-1);
  const error =
    group.lastError ??
    shots
      .map((entry) => entry.analysis.error)
      .filter(Boolean)
      .at(-1);
  const archiveFailed = shots.some((entry) => entry.archiveState === "failed");
  const extractedBlock = extracted
    ? `<details class="group-extract"><summary>查看提取的题面</summary><pre>${escapeHtml([extracted.problemStatement, extracted.additionalContext].filter(Boolean).join("\n\n"))}</pre></details>`
    : "";
  const errorBlock = !answer && error ? `<div class="shot-error">${escapeHtml(error)}</div>` : "";
  const answerBlock =
    history.length > 1
      ? `<div class="answer-history">          <div class="answer-history-head">            <span>解答记录</span>            <span class="hint">共 ${history.length} 次 · 点击展开</span>          </div>          ${history
          .slice()
          .reverse()
          .map((entry, reversedIndex) => {
            const isLatest = reversedIndex === 0;
            const sequence = history.length - reversedIndex;
            return `<details class="answer-history-item${isLatest ? " latest" : ""}" data-history-answer="${entry.id}"${isLatest || openHistoryAnswers.has(entry.id) ? " open" : ""}>                <summary>                  <span class="history-seq">第 ${sequence} 次</span>                  ${isLatest ? `<span class="badge ok">最新</span>` : ""}                  <span>${formatTime(entry.createdAt)}</span>                  <span class="badge ${ANSWER_STATUS_CLASS[entry.status]}">${STATUS_LABEL[entry.status]}</span>                  <span class="spacer"></span>                  ${entry.model ? `<span class="hint history-model">${escapeHtml(entry.model)}</span>` : ""}                </summary>                ${answerHtml(entry, true)}              </details>`;
          })
          .join("")}        </div>`
      : answer
        ? answerHtml(answer)
        : group.status === "answering"
          ? `<div class="empty">正在处理 ${shots.length} 张截图…</div>`
          : `<div class="empty">这一组还没有解答。按 <kbd>Ctrl+Enter</kbd> 开始识题。</div>`;
  if (title)
    title.textContent =
      history.length > 1 ? `第 ${group.seq} 组 · ${history.length} 次解答` : `第 ${group.seq} 组`;
  if (meta) {
    meta.textContent = `${shots.length} 张 · ${GROUP_STATUS_LABEL[group.status]}${archiveFailed ? " · 归档失败" : ""}`;
  }
  host.innerHTML = `<div class="answer-group-head">      <span class="badge ${GROUP_STATUS_CLASS[group.status]}">${GROUP_STATUS_LABEL[group.status]}</span>      <span>${formatTime(group.createdAt)}</span>      <span>${shots.length} 张截图</span>      ${archiveFailed ? `<span class="badge err" title="后台会自动重试归档">归档失败</span>` : ""}    </div>    ${extractedBlock}    ${errorBlock}    ${answerBlock}`;
}
function renderKnowledge(): void {
  const docs = snapshot!.kb.docs;
  $("#kb-status").textContent = `共 ${snapshot!.kb.docCount} 个文档 / ${snapshot!.kb.chunkCount} 个切片`;
  $("#kb-docs").innerHTML = docs.length
    ? docs
        .map(
          (doc: KnowledgeDoc) =>
            `<div class="doc">            <span class="name" title="${escapeHtml(doc.sourcePath || doc.name)}">${escapeHtml(doc.name)}</span>            <span class="meta">${doc.chunks} 片 · ${formatBytes(doc.bytes)}</span>            <button data-action="kb-delete" data-id="${doc.id}">删除</button>          </div>`,
        )
        .join("")
    : `<div class="empty">还没有资料。导入 Markdown、TXT、代码或 JSON 文件用于回答检索。</div>`;
  $("#kb-hits").innerHTML = kbHits
    .map(
      (hit) =>
        `<div class="kb-hit">        <div class="src">${escapeHtml(hit.docName)} · ${hit.score.toFixed(2)}</div>        <div>${escapeHtml(hit.text.slice(0, 260))}${hit.text.length > 260 ? "…" : ""}</div>      </div>`,
    )
    .join("");
}
function setValue(id: string, value: unknown): void {
  const element = document.getElementById(id) as HTMLInputElement | HTMLSelectElement | null;
  if (!element) return;
  if (element instanceof HTMLInputElement && element.type === "checkbox") element.checked = Boolean(value);
  else element.value = String(value ?? "");
}
function buildHotkeySettings(): void {
  const host = document.getElementById("hotkey-groups");
  if (!host || host.dataset.ready === "1") return;
  host.dataset.ready = "1";
  const definitions = visibleHotkeyDefinitions();
  host.innerHTML = HOTKEY_GROUPS.map((group) => {
    const rows = definitions
      .filter((definition) => definition.group === group)
      .map(
        (definition) =>
          `<div class="hotkey-row">          <span class="hotkey-label">            <b>${escapeHtml(definition.label)}</b>            <small>${escapeHtml(definition.description)}</small>          </span>          <span class="hotkey-field">            <input data-hotkey="${definition.id}" readonly placeholder="未绑定" aria-label="${escapeHtml(definition.label)}快捷键" />            <button type="button" class="mini" data-action="hotkey-clear" data-id="${definition.id}" title="清除绑定">×</button>          </span>          <span class="hotkey-state" data-hotkey-state="${definition.id}"></span>        </div>`,
      )
      .join("");
    return `<div class="hotkey-group"><h3>${escapeHtml(group)}</h3>${rows}</div>`;
  }).join("");
  host.querySelectorAll<HTMLInputElement>("input[data-hotkey]").forEach((input) => {
    input.addEventListener("keydown", (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (event.key === "Escape" || event.key === "Backspace" || event.key === "Delete") {
        input.dataset.value = "";
        input.value = "";
        settingsDirty = true;
        renderHotkeyStatus();
        return;
      }
      const accelerator = acceleratorFromKeyboard(event, api.platform);
      if (!accelerator) return;
      input.dataset.value = accelerator;
      input.value = formatAccelerator(accelerator, api.platform);
      settingsDirty = true;
      renderHotkeyStatus();
    });
    input.addEventListener("focus", () => input.select());
  });
}
function renderHotkeySettings(hotkeys: AppSettings["hotkeys"]): void {
  buildHotkeySettings();
  for (const definition of visibleHotkeyDefinitions()) {
    const input = document.querySelector<HTMLInputElement>(
      `#hotkey-groups input[data-hotkey="${definition.id}"]`,
    );
    if (!input) continue;
    const value = hotkeys[definition.id] ?? definition.accelerator;
    input.dataset.value = value;
    input.value = formatAccelerator(value, api.platform);
  }
}
function collectHotkeys(base: AppSettings["hotkeys"]): AppSettings["hotkeys"] {
  const next = { ...base };
  for (const definition of visibleHotkeyDefinitions()) {
    const input = document.querySelector<HTMLInputElement>(
      `#hotkey-groups input[data-hotkey="${definition.id}"]`,
    );
    next[definition.id] = input?.dataset.value?.trim() ?? "";
  }
  return next;
}
type HotkeyStatusEntry = {
  action: string;
  requested: string;
  accelerator: string;
  registered: boolean;
  active: boolean;
  reason: "empty" | "invalid" | "duplicate" | "occupied" | null;
};
let lastHotkeyStatus: { platform: string; registrations: HotkeyStatusEntry[] } | null = null;
function hotkeyDraft(): Array<{ id: HotkeyActionId; label: string; value: string }> {
  return visibleHotkeyDefinitions().map((definition) => {
    const input = document.querySelector<HTMLInputElement>(
      `#hotkey-groups input[data-hotkey="${definition.id}"]`,
    );
    return { id: definition.id, label: definition.label, value: input?.dataset.value?.trim() ?? "" };
  });
}
function duplicateHotkeyLabels(): string[] {
  const seen = new Map<string, string>();
  const duplicates = new Set<string>();
  for (const entry of hotkeyDraft()) {
    if (!entry.value) continue;
    const key = entry.value.toLowerCase();
    const owner = seen.get(key);
    if (owner) duplicates.add(`${owner} / ${entry.label}`);
    else seen.set(key, entry.label);
  }
  return [...duplicates];
}
function renderHotkeyStatus(): void {
  if (!document.getElementById("hotkey-groups")) return;
  const draft = hotkeyDraft();
  const counts = new Map<string, number>();
  for (const entry of draft) {
    if (!entry.value) continue;
    const key = entry.value.toLowerCase();
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const byAction = new Map((lastHotkeyStatus?.registrations ?? []).map((entry) => [entry.action, entry]));
  let active = 0;
  let conflicts = 0;
  let pending = 0;
  for (const entry of draft) {
    const node = document.querySelector<HTMLElement>(`[data-hotkey-state="${entry.id}"]`);
    if (!node) continue;
    let label = "未绑定";
    let state = "off";
    if (entry.value) {
      if ((counts.get(entry.value.toLowerCase()) ?? 0) > 1) {
        label = "重复绑定";
        state = "err";
        conflicts += 1;
      } else {
        const status = byAction.get(entry.id);
        const changed = status ? status.requested.toLowerCase() !== entry.value.toLowerCase() : true;
        if (!status || changed) {
          label = "待保存";
          state = "pending";
          pending += 1;
        } else if (status?.active) {
          label = "正常";
          state = "ok";
          active += 1;
        } else if (status?.reason === "duplicate") {
          label = "重复绑定";
          state = "err";
          conflicts += 1;
        } else if (status?.reason === "occupied") {
          label = "被系统占用";
          state = "err";
          conflicts += 1;
        } else if (status?.reason === "invalid") {
          label = "无效组合";
          state = "err";
          conflicts += 1;
        } else {
          label = "未注册";
          state = "err";
          conflicts += 1;
        }
      }
    }
    node.textContent = label;
    node.className = `hotkey-state ${state}`;
  }
  const summary = document.getElementById("hotkey-summary");
  if (summary) {
    const total = draft.filter((entry) => entry.value).length;
    const state = conflicts > 0 ? "err" : pending > 0 ? "pending" : "ok";
    summary.className = `hotkey-summary ${state}`;
    summary.textContent = !lastHotkeyStatus
      ? "正在检测快捷键状态…"
      : conflicts > 0
        ? `冲突检测：发现 ${conflicts} 个冲突 · 已注册 ${active} / ${total}`
        : pending > 0
          ? `冲突检测：${pending} 项待保存 · 已注册 ${active} / ${total}`
          : `冲突检测：无冲突 · 已注册 ${active} / ${total}`;
  }
}
async function refreshHotkeyStatus(): Promise<void> {
  try {
    lastHotkeyStatus = await invoke<{ platform: string; registrations: HotkeyStatusEntry[] }>(
      "hotkey.status",
    );
  } catch {
    lastHotkeyStatus = null;
  }
  renderHotkeyStatus();
}
function renderSettings(force = false): void {
  if (!snapshot) return;
  const settings = snapshot.settings;
  const json = JSON.stringify(settings);
  if (!force && settingsDirty) {
    renderSecrets();
    return;
  }
  if (!force && json === lastSettingsJson) {
    renderSecrets();
    return;
  }
  lastSettingsJson = json;
  settingsDirty = false;
  setValue("llm-provider", settings.llm.provider);
  setValue("llm-model", settings.llm.model);
  setValue("llm-baseurl", settings.llm.baseUrl);
  setValue("llm-temperature", settings.llm.temperature);
  setValue("llm-maxtokens", settings.llm.maxTokens);
  setValue("llm-style", settings.llm.systemStyle);
  setValue("trans-provider", settings.transcription.provider);
  setValue("trans-mode", settings.transcription.mode);
  syncTranscriptionModeAvailability(settings.transcription.provider);
  setValue("trans-model", settings.transcription.model);
  setValue("trans-baseurl", settings.transcription.baseUrl);
  setValue("trans-language", settings.transcription.language);
  setValue("trans-chunk", settings.transcription.chunkSeconds);
  setValue("voice-mic-speaker", settings.voice.micSpeaker);
  setValue("voice-system-speaker", settings.voice.systemSpeaker);
  (document.getElementById("voice-system-audio") as HTMLInputElement).checked =
    settings.voice.captureSystemAudio;
  setValue("vision-provider", settings.vision.provider);
  setValue("vision-model", settings.vision.model);
  setValue("vision-baseurl", settings.vision.baseUrl);
  setValue("vision-maxtokens", settings.vision.maxTokens);
  (document.getElementById("vision-use-llm") as HTMLInputElement).checked = settings.vision.useLlm;
  setValue("extraction-provider", settings.extraction.provider);
  setValue("extraction-model", settings.extraction.model);
  setValue("extraction-baseurl", settings.extraction.baseUrl);
  setValue("extraction-maxtokens", settings.extraction.maxTokens);
  (document.getElementById("extraction-use-llm") as HTMLInputElement).checked = settings.extraction.useLlm;
  setValue("shot-strategy", settings.screenshot.strategy);
  setValue("shot-maximages", settings.screenshot.maxImages);
  (document.getElementById("shot-fallback") as HTMLInputElement).checked =
    settings.screenshot.fallbackToExtract;
  setValue("trigger-minchars", settings.trigger.minChars);
  setValue("trigger-throttle", settings.trigger.throttleMs);
  setValue("trigger-maxanswers", settings.trigger.maxAnswers);
  setValue("trigger-target", settings.trigger.targetSpeaker);
  setValue("trigger-autodrain", settings.trigger.autoDrainQueue);
  setValue("overlay-opacity", settings.overlay.opacity);
  setValue("overlay-font", settings.overlay.fontSize);
  setValue("overlay-ontop", settings.overlay.alwaysOnTop);
  setValue("kb-enabled", settings.kb.enabled);
  setValue("privacy-exclude-capture", settings.privacy.excludeFromCapture);
  renderHotkeySettings(settings.hotkeys);
  syncReuseControls();
  renderSecrets();
  renderLock();
}
function renderSecrets(): void {
  if (!snapshot) return;
  const status = snapshot.secrets;
  const badge = (id: string, value: boolean, text?: string) => {
    const element = document.getElementById(id);
    if (!element) return;
    element.textContent = text ?? (value ? "已配置" : "未配置");
    element.className = `badge ${value ? "ok" : ""}`;
  };
  badge("secret-llm-status", status.llm);
  badge("secret-transcription-status", status.transcription);
  badge(
    "secret-vision-status",
    snapshot.settings.vision.useLlm ? status.llm : status.vision,
    snapshot.settings.vision.useLlm ? (status.llm ? "复用文本模型" : "缺少文本 Key") : undefined,
  );
  badge(
    "secret-extraction-status",
    snapshot.settings.extraction.useLlm ? status.llm : status.extraction,
    snapshot.settings.extraction.useLlm ? (status.llm ? "复用文本模型" : "缺少文本 Key") : undefined,
  );
  const lock = document.getElementById("lock-status-text");
  if (lock) {
    const enabled = snapshot.lock.enabled;
    lock.textContent = enabled ? "已启用" : "未启用";
    lock.className = `badge ${enabled ? "ok" : ""}`;
  }
}
function syncReuseControls(): void {
  if (!snapshot) return;
  const llm = snapshot.settings.llm;
  const status = snapshot.secrets;
  const sync = (prefix: "vision" | "extraction") => {
    const checkbox = document.getElementById(`${prefix}-use-llm`) as HTMLInputElement | null;
    if (!checkbox) return;
    const enabled = checkbox.checked;
    for (const id of [`${prefix}-provider`, `${prefix}-model`, `${prefix}-baseurl`]) {
      const field = document.getElementById(id) as HTMLInputElement | HTMLSelectElement | null;
      if (field) field.disabled = enabled;
    }
    const keyInput = document.getElementById(`secret-${prefix}`) as HTMLInputElement | null;
    if (keyInput) {
      keyInput.disabled = enabled;
      if (enabled) keyInput.value = "";
    }
    document.querySelectorAll(`#tab-settings [data-key="${prefix}"]`).forEach((node) => {
      (node as HTMLButtonElement).disabled = enabled;
    });
    const hint = document.getElementById(`${prefix}-llm-hint`);
    if (hint) {
      hint.hidden = !enabled;
      hint.textContent = enabled
        ? `使用文本模型：${llm.model} @ ${llm.baseUrl}（Key ${status.llm ? "已配置" : "未配置"}）`
        : "";
    }
  };
  sync("vision");
  sync("extraction");
}
function renderLock(): void {
  if (!snapshot) return;
  const locked = snapshot.lock.enabled && !snapshot.lock.unlocked;
  $("#lock-screen").classList.toggle("hidden", !locked);
  const error = $("#unlock-error");
  if (error) error.textContent = unlockError;
}
function readNumber(id: string, fallback: number): number {
  const element = document.getElementById(id) as HTMLInputElement | null;
  const value = element ? Number(element.value) : Number.NaN;
  return Number.isFinite(value) ? value : fallback;
}
function readText(id: string, fallback: string): string {
  const element = document.getElementById(id) as HTMLInputElement | null;
  const value = element ? element.value.trim() : "";
  return value || fallback;
}
function collectSettings(): AppSettings {
  const base = snapshot!.settings;
  return {
    version: Math.max(3, base.version),
    transcription: {
      provider: readText(
        "trans-provider",
        base.transcription.provider,
      ) as AppSettings["transcription"]["provider"],
      baseUrl: readText("trans-baseurl", base.transcription.baseUrl),
      model: readText("trans-model", base.transcription.model),
      language: readText("trans-language", base.transcription.language),
      chunkSeconds: Math.round(readNumber("trans-chunk", base.transcription.chunkSeconds)),
      mode: readText("trans-mode", base.transcription.mode) as AppSettings["transcription"]["mode"],
    },
    llm: {
      provider: readText("llm-provider", base.llm.provider) as AppSettings["llm"]["provider"],
      baseUrl: readText("llm-baseurl", base.llm.baseUrl),
      model: readText("llm-model", base.llm.model),
      temperature: readNumber("llm-temperature", base.llm.temperature),
      maxTokens: Math.round(readNumber("llm-maxtokens", base.llm.maxTokens)),
      systemStyle: readText("llm-style", base.llm.systemStyle) as AppSettings["llm"]["systemStyle"],
    },
    vision: {
      provider: readText("vision-provider", base.vision.provider) as AppSettings["vision"]["provider"],
      baseUrl: readText("vision-baseurl", base.vision.baseUrl),
      model: readText("vision-model", base.vision.model),
      maxTokens: Math.round(readNumber("vision-maxtokens", base.vision.maxTokens)),
      useLlm: (document.getElementById("vision-use-llm") as HTMLInputElement).checked,
    },
    extraction: {
      provider: readText(
        "extraction-provider",
        base.extraction.provider,
      ) as AppSettings["extraction"]["provider"],
      baseUrl: readText("extraction-baseurl", base.extraction.baseUrl),
      model: readText("extraction-model", base.extraction.model),
      maxTokens: Math.round(readNumber("extraction-maxtokens", base.extraction.maxTokens)),
      useLlm: (document.getElementById("extraction-use-llm") as HTMLInputElement).checked,
    },
    screenshot: {
      strategy: readText("shot-strategy", base.screenshot.strategy) as AppSettings["screenshot"]["strategy"],
      fallbackToExtract: (document.getElementById("shot-fallback") as HTMLInputElement).checked,
      maxImages: Math.round(readNumber("shot-maximages", base.screenshot.maxImages)),
    },
    trigger: {
      autoAnswer: true,
      minChars: Math.round(readNumber("trigger-minchars", base.trigger.minChars)),
      targetSpeaker: readText(
        "trigger-target",
        base.trigger.targetSpeaker,
      ) as AppSettings["trigger"]["targetSpeaker"],
      throttleMs: Math.round(readNumber("trigger-throttle", base.trigger.throttleMs)),
      dedupeWindowMs: base.trigger.dedupeWindowMs,
      autoDrainQueue: (document.getElementById("trigger-autodrain") as HTMLInputElement).checked,
      maxAnswers: Math.round(readNumber("trigger-maxanswers", base.trigger.maxAnswers)),
    },
    overlay: {
      opacity: readNumber("overlay-opacity", base.overlay.opacity),
      fontSize: Math.round(readNumber("overlay-font", base.overlay.fontSize)),
      clickThrough: true,
      compact: base.overlay.compact,
      alwaysOnTop: (document.getElementById("overlay-ontop") as HTMLInputElement).checked,
      bounds: base.overlay.bounds,
    },
    kb: {
      enabled: (document.getElementById("kb-enabled") as HTMLInputElement).checked,
      topK: base.kb.topK,
      maxFileBytes: base.kb.maxFileBytes,
      chunkSize: base.kb.chunkSize,
      chunkOverlap: base.kb.chunkOverlap,
    },
    privacy: {
      ...base.privacy,
      excludeFromCapture: (document.getElementById("privacy-exclude-capture") as HTMLInputElement).checked,
    },
    voice: {
      captureSystemAudio: (document.getElementById("voice-system-audio") as HTMLInputElement).checked,
      micSpeaker: readText("voice-mic-speaker", base.voice.micSpeaker) as Speaker,
      systemSpeaker: readText("voice-system-speaker", base.voice.systemSpeaker) as Speaker,
    },
    hotkeys: collectHotkeys(base.hotkeys),
  };
}
function syncTranscriptionModeAvailability(provider: string): void {
  const select = document.getElementById("trans-mode") as HTMLSelectElement | null;
  if (!select) return;
  const option = select.querySelector("option[value='realtime']") as HTMLOptionElement | null;
  if (option) option.disabled = provider !== "dashscope";
  if (provider !== "dashscope" && select.value === "realtime") select.value = "batch";
}
function applyTranscriptionProviderDefaults(provider: string): void {
  syncTranscriptionModeAvailability(provider);
  const model = ($("#trans-model") as HTMLInputElement | null)?.value.trim() ?? "";
  const baseUrl = ($("#trans-baseurl") as HTMLInputElement | null)?.value.trim() ?? "";
  const language = ($("#trans-language") as HTMLInputElement | null)?.value.trim() ?? "";
  const mode = ($("#trans-mode") as HTMLSelectElement | null)?.value ?? "batch";
  if (provider === "dashscope") {
    if (!model || model === "whisper-1" || model === DASHSCOPE_HTTP_MODEL)
      setValue("trans-model", DASHSCOPE_ASR_MODEL);
    if (!baseUrl || baseUrl === "https://api.openai.com/v1" || baseUrl === DASHSCOPE_HTTP_ENDPOINT) {
      setValue("trans-baseurl", DASHSCOPE_REALTIME_BASE_URL);
    }
    if (!language || language === "zh") setValue("trans-language", DASHSCOPE_ASR_LANGUAGE);
    if (mode === "batch") setValue("trans-mode", "realtime");
    return;
  }
  if (provider === "dashscope-http") {
    if (!model || model === "whisper-1" || model === DASHSCOPE_ASR_MODEL)
      setValue("trans-model", DASHSCOPE_HTTP_MODEL);
    if (!baseUrl || baseUrl === "https://api.openai.com/v1" || baseUrl === DASHSCOPE_REALTIME_BASE_URL) {
      setValue("trans-baseurl", DASHSCOPE_HTTP_ENDPOINT);
    }
    if (mode === "realtime") setValue("trans-mode", "batch");
    return;
  }
  if (model === DASHSCOPE_ASR_MODEL || model === DASHSCOPE_HTTP_MODEL) setValue("trans-model", "whisper-1");
  if (baseUrl === DASHSCOPE_REALTIME_BASE_URL || baseUrl === DASHSCOPE_HTTP_ENDPOINT) {
    setValue("trans-baseurl", "https://api.openai.com/v1");
  }
  if (language === DASHSCOPE_ASR_LANGUAGE) setValue("trans-language", "zh");
  if (mode === "realtime") setValue("trans-mode", "batch");
}
function transcriptionConfigChanged(
  before: AppSettings["transcription"],
  after: AppSettings["transcription"],
): boolean {
  return (
    before.provider !== after.provider ||
    before.baseUrl !== after.baseUrl ||
    before.model !== after.model ||
    before.language !== after.language ||
    before.mode !== after.mode
  );
}
async function syncListening(): Promise<void> {
  await invoke("listening.update", { mic: recorders.has("mic"), system: recorders.has("system") });
}
async function startRecorder(channel: "mic" | "system"): Promise<void> {
  if (recorders.has(channel) || recorderStarts.has(channel) || !snapshot) return;
  recorderStarts.add(channel);
  const label = channel === "mic" ? "麦克风" : "系统声音";
  let acquired: MediaStream | null = null;
  try {
    if (channel === "mic") {
      acquired = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          sampleRate: 16000,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
    } else {
      acquired = await navigator.mediaDevices.getDisplayMedia({
        audio: {
          channelCount: 1,
          sampleRate: 16000,
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
        video: { width: 1, height: 1, frameRate: 1 },
      });
      for (const track of acquired.getVideoTracks()) {
        track.stop();
        acquired.removeTrack(track);
      }
      if (acquired.getAudioTracks().length === 0) throw new Error("没有获取到音频轨道");
    }
  } catch (error) {
    for (const track of acquired?.getTracks() ?? []) track.stop();
    const detail = error instanceof Error && error.message ? `：${error.message}` : "";
    toast("error", channel === "mic" ? `无法访问麦克风${detail}` : `无法获取系统声音${detail}`);
    recorderStarts.delete(channel);
    return;
  }
  const stream = acquired;
  if (!stream) {
    recorderStarts.delete(channel);
    return;
  }
  const transcription = snapshot.settings.transcription;
  const realtime = transcription.provider === "dashscope" && transcription.mode === "realtime";
  if (transcription.provider === "dashscope" && transcription.mode !== "realtime") {
    for (const track of stream.getTracks()) track.stop();
    recorderStarts.delete(channel);
    toast("warn", "DashScope 需要把转写模式切换为“实时流式”");
    return;
  }
  let context: AudioContext;
  let source: MediaStreamAudioSourceNode;
  let processor: ScriptProcessorNode;
  let sink: GainNode;
  try {
    try {
      context = new AudioContext({ sampleRate: 16000 });
    } catch {
      context = new AudioContext();
    }
    await context.resume().catch(() => undefined);
    source = context.createMediaStreamSource(stream);
    processor = context.createScriptProcessor(4096, 1, 1);
    sink = context.createGain();
    sink.gain.value = 0;
    source.connect(processor);
    processor.connect(sink);
    sink.connect(context.destination);
  } catch (error) {
    for (const track of stream.getTracks()) track.stop();
    recorderStarts.delete(channel);
    toast("error", `${label}音频初始化失败：${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  if (realtime) {
    try {
      await invoke("transcribe.startRealtime", { channel });
    } catch (error) {
      try {
        source.disconnect();
        processor.disconnect();
        sink.disconnect();
      } catch {
        // ignore graph cleanup failures
      }
      for (const track of stream.getTracks()) track.stop();
      await context.close().catch(() => undefined);
      recorderStarts.delete(channel);
      toast("error", `${label}实时识别启动失败：${error instanceof Error ? error.message : String(error)}`);
      return;
    }
  }
  const maxUtteranceMs = Math.max(4, snapshot.settings.transcription.chunkSeconds) * 1000;
  const segmenter = new SpeechSegmenter({ sampleRate: 16000, maxUtteranceMs });
  let stopped = false;
  let realtimeChain: Promise<void> = Promise.resolve();
  let realtimeResidual = new Int16Array(0);
  let realtimeFailure = "";
  const pushRealtimeChunk = (samples: Int16Array): void => {
    if (realtimeFailure) return;
    const copy = samples.slice();
    realtimeChain = realtimeChain
      .then(async () => {
        if (realtimeFailure) return;
        await invoke("transcribe.pushPcm", { channel, data: copy.buffer });
      })
      .catch((error) => {
        realtimeFailure = error instanceof Error ? error.message : String(error);
        toast("error", `${label}实时音频上传失败：${realtimeFailure}`);
      });
  };
  const appendRealtime = (samples: Int16Array): void => {
    if (samples.length === 0) return;
    const combined = new Int16Array(realtimeResidual.length + samples.length);
    combined.set(realtimeResidual);
    combined.set(samples, realtimeResidual.length);
    let offset = 0;
    const chunkSamples = 1600;
    while (combined.length - offset >= chunkSamples) {
      pushRealtimeChunk(combined.subarray(offset, offset + chunkSamples));
      offset += chunkSamples;
    }
    realtimeResidual = combined.slice(offset);
  };
  const flushRealtimeResidual = (): void => {
    if (realtimeResidual.length === 0) return;
    const pending = realtimeResidual;
    realtimeResidual = new Int16Array(0);
    pushRealtimeChunk(pending);
  };
  const realtimeFlushTimer = realtime ? setInterval(flushRealtimeResidual, 120) : null;
  const enqueue = (utterance: { pcm: Int16Array; startMs: number; endMs: number }): void => {
    const wav = pcm16ToWav(utterance.pcm, 16000);
    const previous = sendQueues.get(channel) ?? Promise.resolve();
    const task = previous
      .catch(() => undefined)
      .then(async () => {
        await invoke("transcribe.audio", {
          channel,
          mimeType: "audio/wav",
          data: wav.buffer,
          startMs: Math.round(utterance.startMs),
          endMs: Math.round(utterance.endMs),
        });
        await refresh();
      })
      .catch((error) => reportError(error));
    sendQueues.set(channel, task);
  };
  processor.onaudioprocess = (event) => {
    if (stopped) return;
    const input = event.inputBuffer.getChannelData(0);
    updateChannelLevel(channel, rmsLevel(input));
    const mono = context.sampleRate === 16000 ? input : resampleLinear(input, context.sampleRate, 16000);
    const muted = channel === "mic" && isMicrophoneEcho(rmsLevel(mono));
    const pcm = muted ? new Int16Array(mono.length) : float32ToInt16(mono);
    if (realtime) {
      appendRealtime(pcm);
      return;
    }
    for (const utterance of segmenter.push(pcm)) enqueue(utterance);
  };
  const stop = async (_options: { immediate?: boolean } = {}): Promise<void> => {
    if (stopped) return;
    stopped = true;
    processor.onaudioprocess = null;
    if (realtimeFlushTimer) clearInterval(realtimeFlushTimer);
    if (realtime) {
      flushRealtimeResidual();
      await Promise.race([realtimeChain, new Promise<void>((resolve) => setTimeout(resolve, 5000))]);
    } else {
      for (const utterance of segmenter.flush()) enqueue(utterance);
    }
    source.disconnect();
    processor.disconnect();
    sink.disconnect();
    for (const track of stream?.getTracks() ?? []) track.stop();
    await context.close().catch(() => undefined);
    channelAudioLevels[channel] = 0;
    channelLevelsAt[channel] = 0;
    if (channel === "system") {
      lastSystemLevel = 0;
      systemActiveAt = 0;
    }
    if (realtime) {
      try {
        await invoke("transcribe.stopRealtime", { channel });
      } catch (error) {
        if (!realtimeFailure) {
          toast(
            "error",
            `${label}停止实时识别失败：${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      realtimePartials.delete(channel);
      renderSegments();
    }
    recorders.delete(channel);
    await syncListening();
    const pending = sendQueues.get(channel);
    if (pending) {
      await Promise.race([pending, new Promise<void>((resolve) => setTimeout(resolve, 15000))]);
      sendQueues.delete(channel);
    }
    toast("info", `已停止${label}收音`);
  };
  recorders.set(channel, {
    stop,
    mute: () => {
      for (const track of stream.getTracks()) track.stop();
    },
  });
  recorderStarts.delete(channel);
  await syncListening();
  toast("success", `已开始${label}收音`);
}
async function stopRecorder(channel: "mic" | "system"): Promise<void> {
  await recorders.get(channel)?.stop();
}
async function toggleListening(): Promise<void> {
  if (recorders.size > 0 || recorderStarts.size > 0) {
    listenTransition = true;
    updateListenButton(true);
    while (recorderStarts.size > 0) await new Promise((resolve) => setTimeout(resolve, 50));
    for (const recorder of [...recorders.values()]) await recorder.stop();
    listenTransition = false;
    await refresh();
    return;
  }
  listenTransition = true;
  updateListenButton(true);
  const starts = [startRecorder("mic")];
  if (api.platform === "win32" && snapshot?.settings.voice.captureSystemAudio) {
    starts.push(startRecorder("system"));
  }
  await Promise.all(starts);
  listenTransition = false;
  if (recorders.size === 0) updateListenButton(false);
  else await refresh();
}
async function emergencyHide(): Promise<void> {
  listenTransition = false;
  const active = [...recorders.values()]; // Mute the physical tracks first so the microphone LED goes out immediately,
  // then let each recorder finish its normal flush/cleanup path.
  for (const recorder of active) recorder.mute();
  const stopping = active.map((recorder) => recorder.stop().catch(() => undefined));
  await invoke("overlay.hide").catch(() => undefined);
  await Promise.race([Promise.all(stopping), new Promise<void>((resolve) => setTimeout(resolve, 1500))]);
  if (snapshot) {
    snapshot = { ...snapshot, listening: { mic: false, system: false } };
    updateListenHint();
  }
}
async function refresh(): Promise<void> {
  snapshot = await invoke<AppSnapshot>("app.snapshot");
  render();
}
async function handleAction(action: string, node: HTMLElement): Promise<void> {
  const id = node.dataset.id ?? "";
  if (action !== "group-menu" && action !== "capture-menu") closeMenus();
  switch (action) {
    case "new-session":
      await invoke("session.new");
      await refresh();
      break;
    case "toggle-listen":
      await toggleListening();
      break;
    case "toggle-system":
      if (recorders.has("system")) await stopRecorder("system");
      else await startRecorder("system");
      break;
    case "capture-full":
      await invoke("screenshot.captureFull");
      await refresh();
      break;
    case "capture-region":
      await invoke("screenshot.captureRegion");
      break;
    case "capture-menu":
      toggleMenu(node);
      break;
    case "toggle-layout":
      autoExpanded = false;
      await setCompactLayout(!compactLayoutEnabled());
      break;
    case "toggle-voice-answers": {
      const side = document.querySelector(".voice-side");
      side?.classList.toggle("open");
      syncVoiceAnswersToggle();
      break;
    }
    case "group-prev":
      stepGroup(-1);
      break;
    case "group-next":
      stepGroup(1);
      break;
    case "back-more":
      switchTab("more");
      break;
    case "open-settings":
      switchTab("settings");
      if (node.dataset.section === "hotkeys") {
        window.setTimeout(
          () => document.getElementById("hotkey-card")?.scrollIntoView({ block: "start" }),
          120,
        );
      }
      break;
    case "open-knowledge":
      switchTab("knowledge");
      break;
    case "emergency-hide":
      await emergencyHide();
      break;
    case "settings":
      switchTab("settings");
      break;
    case "solve-current":
      await solveCurrentGroup();
      break;
    case "delete-last-shot":
      await deleteLastShot();
      break;
    case "copy-current": {
      const group = currentGroup();
      const text = group ? (findGroupAnswer(group)?.text ?? "") : "";
      if (!text.trim()) {
        toast("warn", "当前组还没有可复制的解答");
        break;
      }
      await copyText(text);
      toast("success", "当前组解答已复制");
      break;
    }
    case "hotkey-clear": {
      const input = document.querySelector<HTMLInputElement>(`#hotkey-groups input[data-hotkey="${id}"]`);
      if (input) {
        input.dataset.value = "";
        input.value = "";
        settingsDirty = true;
        renderHotkeyStatus();
      }
      break;
    }
    case "close":
      window.close();
      break;
    case "clear-transcript":
      await invoke("session.clearSegments");
      await refresh();
      break;
    case "save-settings": {
      const duplicates = duplicateHotkeyLabels();
      if (duplicates.length > 0) {
        toast("warn", `快捷键冲突：${duplicates.join("、")}`);
        document.getElementById("hotkey-card")?.scrollIntoView({ block: "start" });
        break;
      }
      const next = collectSettings();
      const wasCompact = snapshot!.settings.overlay.compact;
      if (
        transcriptionConfigChanged(snapshot!.settings.transcription, next.transcription) &&
        recorders.size > 0
      ) {
        for (const recorder of [...recorders.values()]) await recorder.stop();
      }
      const data = await invoke<AppSnapshot>("settings.update", next);
      snapshot = data;
      if (data.settings.overlay.compact !== wasCompact) {
        await invoke("overlay.layout", { compact: data.settings.overlay.compact });
      }
      settingsDirty = false;
      lastSettingsJson = JSON.stringify(data.settings);
      render();
      toast("success", "设置已保存");
      void refreshHotkeyStatus();
      break;
    }
    case "reset-settings":
      snapshot = await invoke<AppSnapshot>("settings.reset");
      await invoke("overlay.layout", { compact: snapshot.settings.overlay.compact });
      settingsDirty = false;
      lastSettingsJson = "";
      renderSettings(true);
      render();
      toast("info", "已恢复默认设置");
      void refreshHotkeyStatus();
      break;
    case "save-secret": {
      const key = node.dataset.key as string;
      const input = document.getElementById(`secret-${key}`) as HTMLInputElement | null;
      const value = input?.value.trim() ?? "";
      if (!value) {
        toast("warn", "API Key 不能为空");
        break;
      }
      await invoke("secrets.set", { key, value });
      if (input) input.value = "";
      await refresh();
      toast("success", "Key 已保存到本机安全存储");
      break;
    }
    case "clear-secret": {
      const key = node.dataset.key as string;
      await invoke("secrets.clear", { key });
      await refresh();
      toast("info", "Key 已清除");
      break;
    }
    case "test-service": {
      const service = node.dataset.service as string;
      const result = await invoke<{ ok: boolean; message: string; latencyMs?: number }>("providers.test", {
        service,
      });
      toast(
        result.ok ? "success" : "error",
        `${result.message}${result.latencyMs ? `（${result.latencyMs}ms）` : ""}`,
      );
      break;
    }
    case "kb-import": {
      const result = await invoke<{ imported: number }>("kb.pickAndImport");
      await refresh();
      toast("success", `已导入 ${result.imported} 个文档`);
      break;
    }
    case "kb-search": {
      const query = ($("#kb-search") as HTMLInputElement).value.trim();
      if (!query) break;
      const result = await invoke<{ hits: Array<{ docName: string; text: string; score: number }> }>(
        "kb.search",
        { query },
      );
      kbHits = result.hits;
      renderKnowledge();
      break;
    }
    case "kb-delete":
      await invoke("kb.delete", { id });
      kbHits = [];
      await refresh();
      toast("info", "文档已删除");
      break;
    case "shot-analyze":
      selectedGroupId =
        snapshot?.groups.find((group) => group.screenshotIds.includes(id))?.id ?? selectedGroupId;
      await invoke("screenshot.analyze", {
        id,
        ...(node.dataset.strategy ? { strategy: node.dataset.strategy } : {}),
      });
      switchTab("shots");
      await refresh();
      break;
    case "shot-extract": {
      const result = await invoke<{ extracted: { problemStatement: string; additionalContext: string } }>(
        "screenshot.extract",
        { id },
      );
      await refresh();
      toast("success", result.extracted.problemStatement ? "题面已提取" : "没有提取到题面");
      break;
    }
    case "shot-continue":
      selectedGroupId =
        snapshot?.groups.find((group) => group.screenshotIds.includes(id))?.id ?? selectedGroupId;
      await invoke("screenshot.continue", { id });
      switchTab("shots");
      await refresh();
      break;
    case "group-menu":
      toggleMenu(node);
      break;
    case "group-solve":
      await invoke("screenshot.solve", { groupId: id });
      selectedGroupId = id;
      await refresh();
      break;
    case "group-retry":
      await invoke("screenshot.retry", { groupId: id });
      selectedGroupId = id;
      await refresh();
      break;
    case "group-extract": {
      const result = await invoke<{ extracted: { problemStatement: string; additionalContext: string } }>(
        "screenshot.extractGroup",
        { groupId: id },
      );
      await refresh();
      toast("success", result.extracted.problemStatement ? "题面已提取" : "没有提取到题面");
      break;
    }
    case "group-reopen":
      await invoke("screenshot.reopen", { groupId: id });
      selectedGroupId = id;
      await refresh();
      break;
    case "group-close": {
      const result = await invoke<{ closed: boolean }>("screenshot.closeGroup", { groupId: id });
      await refresh();
      if (result.closed) toast("info", "本组已结束，下次截图会新建一组");
      break;
    }
    case "group-delete": {
      const group = snapshot?.groups.find((entry) => entry.id === id);
      await invoke("screenshot.deleteGroup", { groupId: id });
      group?.screenshotIds.forEach((shotId) => thumbs.delete(shotId));
      if (selectedGroupId === id) selectedGroupId = null;
      await refresh();
      toast("info", "本组截图与解答已删除");
      break;
    }
    case "group-stop": {
      await invoke("screenshot.stopGroup", { groupId: id });
      await refresh();
      break;
    }
    case "group-copy": {
      const group = snapshot?.groups.find((entry) => entry.id === id);
      const answer = group ? findGroupAnswer(group) : null;
      await copyText(answer?.text ?? "");
      toast("success", "解答已复制");
      break;
    }
    case "shot-archive": {
      const meta = snapshot?.screenshots.find((item) => item.id === id);
      if (!meta) break;
      const result = await invoke<ScreenshotMeta>("screenshot.archive", {
        id,
        guard: {
          requestId: meta.requestId,
          screenshotContextId: meta.screenshotContextId,
          archiveRequestId: meta.archiveRequestId,
        },
      });
      await refresh();
      toast(
        result.archiveState === "archived" ? "success" : "warn",
        result.archiveState === "archived" ? "归档完成" : "归档失败，可重试",
      );
      break;
    }
    case "shot-delete":
      await invoke("screenshot.delete", { id });
      thumbs.delete(id);
      await refresh();
      toast("info", "已删除这张截图");
      break;
    case "answer-cancel":
      await invoke("answer.cancel", { answerId: id });
      await refresh();
      break;
    case "answer-retry":
      await invoke("answer.retry", { answerId: id });
      await refresh();
      break;
    case "queue-remove":
      await invoke("queue.remove", { id });
      await refresh();
      break;
    case "queue-next":
      await invoke("queue.next");
      await refresh();
      break;
    case "queue-clear":
      await invoke("queue.clear");
      await refresh();
      break;
    case "lock-set": {
      const passcode = ($("#lock-passcode") as HTMLInputElement).value;
      if (passcode.length < 4) {
        toast("warn", "密码至少 4 位");
        break;
      }
      await invoke("lock.set", { passcode });
      ($("#lock-passcode") as HTMLInputElement).value = "";
      await refresh();
      toast("success", "本地锁已启用");
      break;
    }
    case "lock-clear": {
      const passcode = ($("#lock-passcode") as HTMLInputElement).value;
      await invoke("lock.clear", { passcode });
      ($("#lock-passcode") as HTMLInputElement).value = "";
      await refresh();
      toast("info", "本地锁已关闭");
      break;
    }
    case "unlock": {
      const passcode = ($("#unlock-passcode") as HTMLInputElement).value;
      try {
        await invoke("lock.unlock", { passcode });
        unlockError = "";
        ($("#unlock-passcode") as HTMLInputElement).value = "";
        await refresh();
      } catch (error) {
        unlockError = error instanceof Error ? error.message : String(error);
        renderLock();
      }
      break;
    }
    default:
      break;
  }
}
function bindResizeGrip(): void {
  const grip = document.getElementById("resize-grip");
  if (!grip) return;
  let active = false;
  let startX = 0;
  let startY = 0;
  let startWidth = 0;
  let startHeight = 0;
  let frame = 0;
  let pendingWidth = 0;
  let pendingHeight = 0;
  const apply = (): void => {
    frame = 0;
    if (!active) return;
    void invoke("overlay.resize", { width: pendingWidth, height: pendingHeight }).catch(() => undefined);
  };
  grip.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    active = true;
    void invoke("overlay.interaction", { active: true }).catch(() => undefined);
    startX = event.screenX;
    startY = event.screenY;
    startWidth = window.outerWidth;
    startHeight = window.outerHeight;
    pendingWidth = startWidth;
    pendingHeight = startHeight;
    grip.classList.add("active");
    grip.setPointerCapture(event.pointerId);
  });
  grip.addEventListener("pointermove", (event) => {
    if (!active) return;
    pendingWidth = Math.max(360, Math.round(startWidth + event.screenX - startX));
    pendingHeight = Math.max(420, Math.round(startHeight + event.screenY - startY));
    if (!frame) frame = requestAnimationFrame(apply);
  });
  const finish = (event: PointerEvent): void => {
    if (!active) return;
    active = false;
    void invoke("overlay.interaction", { active: false }).catch(() => undefined);
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    grip.classList.remove("active");
    try {
      grip.releasePointerCapture(event.pointerId);
    } catch {
      // pointer capture may already be released
    }
  };
  grip.addEventListener("pointerup", finish);
  grip.addEventListener("pointercancel", finish);
}
function bindDom(): void {
  document.addEventListener(
    "pointerdown",
    (event) => {
      if (event.button === 0) activateInteraction();
      const editable = editableElement(event.target);
      if (!editable) return;
      setKeyboardCapture(true); // The click itself must not be lost while the main process switches the
      // native window into keyboard-focusable mode.
      window.setTimeout(() => {
        if (editable.isConnected && document.activeElement !== editable) editable.focus();
      }, 40);
    },
    true,
  );
  document.addEventListener("focusin", (event) => {
    if (editableElement(event.target)) setKeyboardCapture(true);
  });
  document.addEventListener("focusout", () => {
    if (keyboardReleaseTimer) window.clearTimeout(keyboardReleaseTimer);
    keyboardReleaseTimer = window.setTimeout(() => {
      keyboardReleaseTimer = 0;
      if (editableElement(document.activeElement)) return;
      setKeyboardCapture(false);
      if (!keyboardCapture) setInteractionActive(false);
    }, 120);
  });
  window.addEventListener("focus", () => setInteractionActive(true));
  window.addEventListener("blur", () => {
    if (interactionTimer) window.clearTimeout(interactionTimer);
    interactionTimer = 0;
    if (keyboardReleaseTimer) window.clearTimeout(keyboardReleaseTimer);
    keyboardReleaseTimer = 0;
    keyboardCapture = false;
    setInteractionActive(false);
  });
  window.addEventListener("resize", publishHitRegions);
  document.addEventListener("scroll", publishHitRegions, true);
  const groupNav = document.getElementById("group-nav");
  let groupSwipe: {
    startX: number;
    startY: number;
    lastX: number;
    lastY: number;
    pointerId: number;
    capturing: boolean;
  } | null = null;
  let suppressGroupNavClick = false;
  let groupWheelDelta = 0;
  let groupWheelTimer = 0;
  const finishGroupSwipe = (event: PointerEvent): void => {
    if (!groupSwipe || groupSwipe.pointerId !== event.pointerId) return;
    const swipe = groupSwipe;
    groupSwipe = null;
    groupNav?.classList.remove("swiping");
    if (groupNav?.hasPointerCapture?.(event.pointerId)) {
      try {
        groupNav.releasePointerCapture(event.pointerId);
      } catch {
        // pointer capture may already be released
      }
    }
    const dx = swipe.lastX - swipe.startX;
    const dy = swipe.lastY - swipe.startY;
    if (Math.abs(dx) < 30 || Math.abs(dx) < Math.abs(dy)) return;
    suppressGroupNavClick = true;
    window.setTimeout(() => {
      suppressGroupNavClick = false;
    }, 0);
    stepGroup(dx < 0 ? 1 : -1);
  };
  groupNav?.addEventListener("pointerdown", (event) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    groupSwipe = {
      startX: event.clientX,
      startY: event.clientY,
      lastX: event.clientX,
      lastY: event.clientY,
      pointerId: event.pointerId,
      capturing: false,
    };
    groupNav.classList.add("swiping");
  });
  window.addEventListener(
    "pointermove",
    (event) => {
      if (!groupSwipe || groupSwipe.pointerId !== event.pointerId) return;
      groupSwipe.lastX = event.clientX;
      groupSwipe.lastY = event.clientY;
      if (!groupSwipe.capturing && Math.abs(event.clientX - groupSwipe.startX) > 10) {
        try {
          groupNav.setPointerCapture?.(event.pointerId);
          groupSwipe.capturing = true;
        } catch {
          // Synthetic pointer events have no active pointer to capture.
        }
      }
    },
    true,
  );
  window.addEventListener("pointerup", finishGroupSwipe, true);
  window.addEventListener(
    "pointercancel",
    (event) => {
      if (!groupSwipe || groupSwipe.pointerId !== event.pointerId) return;
      groupSwipe = null;
      groupNav?.classList.remove("swiping");
    },
    true,
  );
  groupNav?.addEventListener(
    "click",
    (event) => {
      if (!suppressGroupNavClick) return;
      suppressGroupNavClick = false;
      event.preventDefault();
      event.stopPropagation();
    },
    true,
  );
  groupNav?.addEventListener(
    "wheel",
    (event) => {
      if (Math.abs(event.deltaX) <= Math.abs(event.deltaY)) return;
      event.preventDefault();
      groupWheelDelta += event.deltaX;
      if (groupWheelTimer) window.clearTimeout(groupWheelTimer);
      groupWheelTimer = window.setTimeout(() => {
        groupWheelDelta = 0;
        groupWheelTimer = 0;
      }, 260);
      if (Math.abs(groupWheelDelta) < 48) return;
      const direction: -1 | 1 = groupWheelDelta > 0 ? 1 : -1;
      groupWheelDelta = 0;
      stepGroup(direction);
    },
    { passive: false },
  );
  document.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;
    const actionNode = target.closest<HTMLElement>("[data-action]");
    if (actionNode) {
      event.preventDefault();
      void handleAction(actionNode.dataset.action ?? "", actionNode).catch(reportError);
      return;
    }
    if (!target.closest(".menu-wrap")) closeMenus();
    const tabNode = target.closest<HTMLElement>(".nav-strip [data-tab]");
    if (tabNode) {
      switchTab(tabNode.dataset.tab as typeof activeTab);
      return;
    }
    const groupNode = target.closest<HTMLElement>("#shots [data-group-id]");
    if (groupNode && groupNode.dataset.groupId && groupNode.dataset.groupId !== selectedGroupId) {
      selectGroup(groupNode.dataset.groupId);
      return;
    }
    const chip = target.closest<HTMLElement>("[data-speaker-toggle]");
    if (chip && snapshot) {
      const segmentId = chip.dataset.speakerToggle ?? "";
      const segment = snapshot.session.segments.find((entry) => entry.id === segmentId);
      if (!segment) return;
      const next: Speaker = segment.speaker === "me" ? "interviewer" : "me";
      void invoke("transcript.setSpeaker", { id: segmentId, speaker: next }).then(refresh).catch(reportError);
    }
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      closeMenus();
      releaseInteraction();
    }
  });
  $("#ask-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const input = $("#ask-input") as HTMLTextAreaElement;
    const text = input.value.trim();
    if (!text) return;
    void invoke("answer.start", { question: text, trigger: "manual" })
      .then(() => {
        input.value = "";
        return refresh();
      })
      .catch(reportError);
  });
  $("#ask-input").addEventListener("keydown", (event) => {
    const keyboard = event as KeyboardEvent;
    if (keyboard.key === "Enter" && !keyboard.shiftKey) {
      keyboard.preventDefault();
      ($("#ask-form") as HTMLFormElement).requestSubmit();
    }
  });
  $("#tab-settings").addEventListener("input", () => {
    settingsDirty = true;
  });
  $("#tab-settings").addEventListener("change", () => {
    settingsDirty = true;
  });
  document.getElementById("trans-provider")?.addEventListener("change", (event) => {
    settingsDirty = true;
    applyTranscriptionProviderDefaults((event.target as HTMLSelectElement).value);
  });
  for (const id of ["vision-use-llm", "extraction-use-llm"]) {
    document.getElementById(id)?.addEventListener("change", () => {
      settingsDirty = true;
      syncReuseControls();
      renderSecrets();
    });
  }
  window.addEventListener("error", (event) => {
    toast("error", String(event.message));
  });
}
async function boot(): Promise<void> {
  bindEvents();
  bindDom();
  bindResizeGrip();
  try {
    const savedScale = Number(localStorage.getItem("dh-ui-scale"));
    if (Number.isFinite(savedScale) && savedScale >= 0.8 && savedScale <= 1.4) applyUiScale(savedScale);
  } catch {
    // ignore storage failures
  }
  await refresh();
  try {
    await invoke("app.ready", { renderer: "main" });
  } catch {
    // non fatal
  }
}
void boot().catch(reportError);
