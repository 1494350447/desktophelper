import { mkdir, readFile, unlink, writeFile, copyFile } from "node:fs/promises";
import { join } from "node:path";
import type { Display, NativeImage } from "electron";
import type { ScreenshotMeta } from "../shared/models.ts";
import { createId } from "../shared/ids.ts";
import { AppError } from "../shared/result.ts";

export type CaptureResult = {
  image: NativeImage;
  display: Display;
  sourceId: string;
};

export async function captureDisplay(displayId?: string): Promise<CaptureResult> {
  const { desktopCapturer, screen } = await import("electron");
  const displays = screen.getAllDisplays();
  const display =
    (displayId ? displays.find((entry) => String(entry.id) === displayId) : undefined) ??
    screen.getPrimaryDisplay();
  const width = Math.max(1, Math.round(display.size.width * display.scaleFactor));
  const height = Math.max(1, Math.round(display.size.height * display.scaleFactor));
  const sources = await desktopCapturer.getSources({
    types: ["screen"],
    thumbnailSize: { width, height },
    fetchWindowIcons: false,
  });
  if (sources.length === 0) throw new AppError("UNSUPPORTED", "系统未提供可捕获的屏幕");
  const source = sources.find((entry) => entry.display_id === String(display.id)) ?? sources[0];
  const image = source.thumbnail;
  if (!image || image.isEmpty()) throw new AppError("INTERNAL", "屏幕捕获返回了空图像");
  return { image, display, sourceId: source.id };
}

export type PendingRegionCapture = {
  displayId: string;
  display: Display;
  image: NativeImage;
  previewDataUrl: string;
  capturedAt: number;
};

export type RegionPreview = {
  displayId: string;
  width: number;
  height: number;
  scaleFactor: number;
  dataUrl: string;
};

let pendingRegionCapture: PendingRegionCapture | null = null;

export function rememberRegionCapture(capture: CaptureResult, now = Date.now()): PendingRegionCapture {
  // Full-resolution pixels stay in memory for the final crop, but the
  // selector preview travels over IPC as a data URL. Down-scaling it keeps
  // that payload small enough to paint before the selector window is shown.
  const size = capture.image.getSize();
  const preview =
    size.width > 1920
      ? capture.image.resize({ width: 1920, quality: "good" })
      : capture.image;
  const pending: PendingRegionCapture = {
    displayId: String(capture.display.id),
    display: capture.display,
    image: capture.image,
    previewDataUrl: `data:image/jpeg;base64,${preview.toJPEG(82).toString("base64")}`,
    capturedAt: now,
  };
  pendingRegionCapture = pending;
  return pending;
}

export function getRegionPreview(displayId: string): RegionPreview | null {
  if (!pendingRegionCapture || pendingRegionCapture.displayId !== displayId) return null;
  const display = pendingRegionCapture.display;
  return {
    displayId,
    width: display.size.width,
    height: display.size.height,
    scaleFactor: display.scaleFactor,
    dataUrl: pendingRegionCapture.previewDataUrl,
  };
}

export function getPendingRegionCapture(displayId: string): PendingRegionCapture | null {
  if (!pendingRegionCapture || pendingRegionCapture.displayId !== displayId) return null;
  return pendingRegionCapture;
}

export function clearPendingRegionCapture(): void {
  pendingRegionCapture = null;
}

export function cropImage(
  image: NativeImage,
  display: Display,
  rect: { x: number; y: number; width: number; height: number },
): NativeImage {
  const size = image.getSize();
  const ratioX = size.width / display.size.width;
  const ratioY = size.height / display.size.height;
  const x = Math.max(0, Math.round(rect.x * ratioX));
  const y = Math.max(0, Math.round(rect.y * ratioY));
  const width = Math.max(1, Math.min(Math.round(rect.width * ratioX), size.width - x));
  const height = Math.max(1, Math.min(Math.round(rect.height * ratioY), size.height - y));
  return image.crop({ x, y, width, height });
}

export async function saveScreenshot(
  dataDir: string,
  image: NativeImage,
  mode: "full" | "region",
  display: Display,
  now: number,
): Promise<{ meta: ScreenshotMeta; dataUrl: string }> {
  const dir = join(dataDir, "screenshots");
  await mkdir(dir, { recursive: true });
  const id = createId("shot", { now });
  const file = `${id}.png`;
  const buffer = image.toPNG();
  await writeFile(join(dir, file), buffer);
  const size = image.getSize();
  const meta: ScreenshotMeta = {
    id,
    createdAt: now,
    mode,
    width: size.width,
    height: size.height,
    file,
    displayId: String(display.id),
    requestId: createId("req", { now }),
    screenshotContextId: createId("ctx", { now }),
    archiveRequestId: createId("arc", { now }),
    archiveState: "pending",
    archiveAttempts: 0,
    analysis: { status: "idle" },
  };
  return { meta, dataUrl: `data:image/png;base64,${buffer.toString("base64")}` };
}

export async function readScreenshotAsDataUrl(dataDir: string, meta: ScreenshotMeta): Promise<string> {
  const buffer = await readFile(join(dataDir, "screenshots", meta.file));
  return `data:image/png;base64,${buffer.toString("base64")}`;
}

const MODEL_IMAGE_MAX_WIDTH = 1600;
const MODEL_IMAGE_MAX_BYTES = 1_500_000;

export async function readScreenshotForModel(dataDir: string, meta: ScreenshotMeta): Promise<string> {
  const buffer = await readFile(join(dataDir, "screenshots", meta.file));
  try {
    const { nativeImage } = await import("electron");
    const image = nativeImage.createFromBuffer(buffer);
    if (image.isEmpty()) return `data:image/png;base64,${buffer.toString("base64")}`;
    const size = image.getSize();
    if (size.width <= MODEL_IMAGE_MAX_WIDTH && buffer.length <= MODEL_IMAGE_MAX_BYTES) {
      return `data:image/png;base64,${buffer.toString("base64")}`;
    }
    const resized =
      size.width > MODEL_IMAGE_MAX_WIDTH
        ? image.resize({ width: MODEL_IMAGE_MAX_WIDTH, quality: "good" })
        : image;
    return `data:image/jpeg;base64,${resized.toJPEG(82).toString("base64")}`;
  } catch {
    return `data:image/png;base64,${buffer.toString("base64")}`;
  }
}

export async function deleteScreenshotFile(dataDir: string, meta: ScreenshotMeta): Promise<void> {
  try {
    await unlink(join(dataDir, "screenshots", meta.file));
  } catch {
    // already removed
  }
}

export async function archiveScreenshotFile(dataDir: string, meta: ScreenshotMeta, now: number): Promise<string> {
  if (process.env.DH_ARCHIVE_FAIL === "1") {
    throw new AppError("INTERNAL", "归档写入失败（模拟）");
  }
  const day = new Date(now).toISOString().slice(0, 10);
  const dir = join(dataDir, "archive", day);
  await mkdir(dir, { recursive: true });
  const target = join(dir, meta.file);
  await copyFile(join(dataDir, "screenshots", meta.file), target);
  return target;
}

