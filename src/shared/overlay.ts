export type OverlayPoint = { x: number; y: number };

export type OverlayBounds = { x: number; y: number; width: number; height: number };

export type OverlayHitRegion = { x: number; y: number; width: number; height: number };

export type OverlayZone = {
  inside: boolean;
  drag: boolean;
  resize: boolean;
  control: boolean;
};

export type OverlayZoneOptions = {
  dragBand?: number;
  resizeBand?: number;
  resizeCorner?: number;
  regions?: OverlayHitRegion[];
};

/**
 * Target bounds for one manual drag step. The size always comes from the
 * original bounds: Windows rounds physical pixels at fractional DPI, so
 * moving with setPosition alone can grow the window by a pixel or two on
 * every pointer event.
 */
export function overlayDragBounds(origin: OverlayBounds, dx = 0, dy = 0): OverlayBounds {
  const offsetX = Number.isFinite(dx) ? Math.round(dx) : 0;
  const offsetY = Number.isFinite(dy) ? Math.round(dy) : 0;
  return {
    x: origin.x + offsetX,
    y: origin.y + offsetY,
    width: origin.width,
    height: origin.height,
  };
}

/**
 * Hit zones used while the overlay is in click-through mode. Only the title
 * band and the window edges may wake the window; everything else keeps
 * forwarding clicks to the application underneath.
 */
export function overlayHitZone(
  cursor: OverlayPoint,
  bounds: OverlayBounds,
  options: OverlayZoneOptions = {},
): OverlayZone {
  const dragBand = Math.max(0, options.dragBand ?? 46);
  const resizeBand = Math.max(0, options.resizeBand ?? 10);
  const resizeCorner = Math.max(0, options.resizeCorner ?? 30);
  const inside =
    cursor.x >= bounds.x &&
    cursor.x < bounds.x + bounds.width &&
    cursor.y >= bounds.y &&
    cursor.y < bounds.y + bounds.height;
  if (!inside) return { inside: false, drag: false, resize: false, control: false };
  const localX = cursor.x - bounds.x;
  const localY = cursor.y - bounds.y;
  const corner = localX >= bounds.width - resizeCorner && localY >= bounds.height - resizeCorner;
  const control = Boolean(
    options.regions?.some(
      (region) =>
        localX >= region.x &&
        localX < region.x + region.width &&
        localY >= region.y &&
        localY < region.y + region.height,
    ),
  );
  return {
    inside: true,
    drag: localY <= dragBand,
    control,
    resize:
      corner ||
      localX <= resizeBand ||
      localX >= bounds.width - resizeBand ||
      localY >= bounds.height - resizeBand,
  };
}
