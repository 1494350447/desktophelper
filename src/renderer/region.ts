import { isUsableRegion, rectFromPoints, type Point, type Rect } from "../shared/region.ts";

type Api = {
  invoke: (channel: string, payload?: unknown) => Promise<{ ok: boolean; data?: unknown; error?: { message: string } }>;
};
declare global {
  interface Window {
    desktophelper: Api;
  }
}

const params = new URLSearchParams(location.search);
const displayId = params.get("displayId") ?? "0";
const preview = document.getElementById("preview") as HTMLImageElement;
const box = document.getElementById("box") as HTMLDivElement;
const size = document.getElementById("size") as HTMLDivElement;
const hint = document.getElementById("hint") as HTMLDivElement;

const IDLE_HINT = "点击左上角起点 · Esc 取消";
const SECOND_HINT = "点击右下角终点 · Esc 取消";

let origin: Point | null = null;
let ready = false;

async function init(): Promise<void> {
  const result = await window.desktophelper.invoke("screenshot.regionPreview", { displayId });
  if (!result.ok) {
    hint.textContent = result.error?.message ?? "截图预览加载失败";
    await cancel();
    return;
  }
  const data = result.data as { dataUrl: string };
  preview.src = data.dataUrl;
  try {
    await preview.decode();
  } catch {
    await new Promise<void>((resolve) => {
      preview.addEventListener("load", () => resolve(), { once: true });
      preview.addEventListener("error", () => resolve(), { once: true });
    });
  }
  if (!preview.naturalWidth || !preview.naturalHeight) {
    hint.textContent = "截图预览加载失败";
    await cancel();
    return;
  }
  ready = true;
  hint.textContent = IDLE_HINT;
  await window.desktophelper.invoke("screenshot.regionReady", {});
}

function paint(rect: Rect): void {
  box.style.display = "block";
  box.style.left = `${rect.x}px`;
  box.style.top = `${rect.y}px`;
  box.style.width = `${rect.width}px`;
  box.style.height = `${rect.height}px`;
  size.style.display = "block";
  size.style.left = `${rect.x}px`;
  size.style.top = `${Math.max(0, rect.y - 24)}px`;
  size.textContent = `${Math.round(rect.width)} × ${Math.round(rect.height)}`;
}

function clearPaint(): void {
  box.style.display = "none";
  size.style.display = "none";
}

async function submit(rect: Rect): Promise<void> {
  hint.textContent = "正在截图…";
  clearPaint();
  const result = await window.desktophelper.invoke("screenshot.submitRegion", {
    displayId,
    rect,
    scaleFactor: window.devicePixelRatio || 1,
  });
  if (!result.ok) {
    hint.textContent = result.error?.message ?? "截图失败";
    setTimeout(() => {
      hint.textContent = IDLE_HINT;
    }, 2200);
  }
}

async function cancel(): Promise<void> {
  await window.desktophelper.invoke("screenshot.cancelRegion", {});
}

window.addEventListener("click", (event) => {
  if (!ready) return;
  if (event.button !== 0) return;
  const point = { x: event.clientX, y: event.clientY };
  if (!origin) {
    origin = point;
    paint(rectFromPoints(point, point));
    hint.textContent = SECOND_HINT;
    return;
  }
  const rect = rectFromPoints(origin, point);
  if (!isUsableRegion(rect)) {
    origin = point;
    paint(rectFromPoints(point, point));
    hint.textContent = "区域太小，已重新开始 · " + SECOND_HINT;
    return;
  }
  paint(rect);
  origin = null;
  void submit(rect);
});

window.addEventListener("mousemove", (event) => {
  if (!origin) return;
  paint(rectFromPoints(origin, { x: event.clientX, y: event.clientY }));
});

window.addEventListener("keydown", (event) => {
  if (event.key === "Escape") void cancel();
});

window.addEventListener("contextmenu", (event) => {
  event.preventDefault();
  void cancel();
});

void init();
