import { rectFromPoints, type Point, type Rect } from "../shared/region.ts";

export type PointerEvent =
  | { type: "ready" }
  | { type: "point"; x: number; y: number; monitor?: MonitorInfo }
  | { type: "done"; start: Point; end: Point; monitor?: MonitorInfo }
  | { type: "cancel"; reason: string };

export type MonitorInfo = {
  x: number;
  y: number;
  width: number;
  height: number;
  dpi: number;
};

export type DisplayBounds = {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
};

export type DisplayRegion = {
  displayId: string;
  rect: Rect;
};

function validPoint(value: unknown): value is Point {
  if (!value || typeof value !== "object") return false;
  const point = value as Point;
  return Number.isFinite(point.x) && Number.isFinite(point.y);
}

function validMonitor(value: unknown): value is MonitorInfo {
  if (!value || typeof value !== "object") return false;
  const monitor = value as MonitorInfo;
  return (
    Number.isFinite(monitor.x) &&
    Number.isFinite(monitor.y) &&
    Number.isFinite(monitor.width) &&
    Number.isFinite(monitor.height) &&
    Number.isFinite(monitor.dpi) &&
    monitor.width > 0 &&
    monitor.height > 0 &&
    monitor.dpi > 0
  );
}

export function parsePointerEvent(line: string): PointerEvent | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object") return null;
  const event = value as Record<string, unknown>;
  if (event.type === "ready") return { type: "ready" };
  if (event.type === "point" && Number.isFinite(event.x) && Number.isFinite(event.y)) {
    return {
      type: "point",
      x: Number(event.x),
      y: Number(event.y),
      ...(validMonitor(event.monitor) ? { monitor: event.monitor } : {}),
    };
  }
  if (event.type === "done" && validPoint(event.start) && validPoint(event.end)) {
    return {
      type: "done",
      start: event.start,
      end: event.end,
      ...(validMonitor(event.monitor) ? { monitor: event.monitor } : {}),
    };
  }
  if (event.type === "cancel") {
    return { type: "cancel", reason: typeof event.reason === "string" ? event.reason : "unknown" };
  }
  return null;
}

function intersect(rect: Rect, bounds: DisplayBounds): Rect | null {
  const left = Math.max(rect.x, bounds.x);
  const top = Math.max(rect.y, bounds.y);
  const right = Math.min(rect.x + rect.width, bounds.x + bounds.width);
  const bottom = Math.min(rect.y + rect.height, bounds.y + bounds.height);
  if (right <= left || bottom <= top) return null;
  return {
    x: left - bounds.x,
    y: top - bounds.y,
    width: right - left,
    height: bottom - top,
  };
}

export function regionOnDisplays(start: Point, end: Point, displays: DisplayBounds[]): DisplayRegion | null {
  const rect = rectFromPoints(start, end);
  let best: DisplayRegion | null = null;
  for (const display of displays) {
    const clipped = intersect(rect, display);
    if (!clipped) continue;
    if (!best || clipped.width * clipped.height > best.rect.width * best.rect.height) {
      best = { displayId: display.id, rect: clipped };
    }
  }
  return best;
}

export type DipDisplay = {
  bounds: { x: number; y: number };
  scaleFactor: number;
};

// Windows pointer helpers report physical pixels while Electron screen bounds
// use DIP. Map the physical point through the monitor that owns it instead of
// trusting screen.screenToDipPoint(), which is a no-op in some Electron builds.
export function physicalPointToDip(point: Point, monitor: MonitorInfo, display: DipDisplay): Point {
  const scale = monitor.dpi > 0 ? monitor.dpi / 96 : display.scaleFactor || 1;
  if (!(scale > 0)) return { x: point.x, y: point.y };
  return {
    x: display.bounds.x + (point.x - monitor.x) / scale,
    y: display.bounds.y + (point.y - monitor.y) / scale,
  };
}
