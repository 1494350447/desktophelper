export type Point = { x: number; y: number };

export type Rect = { x: number; y: number; width: number; height: number };

export function rectFromPoints(origin: Point, end: Point): Rect {
  return {
    x: Math.min(origin.x, end.x),
    y: Math.min(origin.y, end.y),
    width: Math.abs(end.x - origin.x),
    height: Math.abs(end.y - origin.y),
  };
}

export function isUsableRegion(rect: Rect, minimum = 6): boolean {
  return rect.width >= minimum && rect.height >= minimum;
}
