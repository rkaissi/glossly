import type { Point, Rect } from '../types';

export interface Size {
  w: number;
  h: number;
}

export interface Placement {
  mode: 'pill' | 'dot';
  side: 'below' | 'above' | 'end';
  rect: Rect;
}

export interface PlacementInput {
  /** Selection bounds. Same coordinate space as everything else (DIP in the shell). */
  selection: Rect;
  /** Where the selection ends, usually the mouse-up point. Defaults to the bottom-right corner. */
  anchor?: Point;
  /** Toolbars and popups from popups_near. */
  obstacles: Rect[];
  size: Size;
  workArea: Rect;
  gap?: number;
  dotSize?: number;
}

const MARGIN = 6;

function intersects(a: Rect, b: Rect, margin = 0): boolean {
  return a.x - margin < b.x + b.w && b.x < a.x + a.w + margin && a.y - margin < b.y + b.h && b.y < a.y + a.h + margin;
}

function clampX(x: number, w: number, area: Rect): number {
  return Math.min(Math.max(x, area.x), area.x + area.w - w);
}

/**
 * Places the pill near the end of the selection without covering the app's own toolbar:
 * below by default, above if something is below (or there is no room), and a small dot at
 * the end of the selection if both sides are taken.
 */
export function placePill(input: PlacementInput): Placement {
  const { selection: sel, size, workArea: area, obstacles } = input;
  const gap = input.gap ?? 8;
  const dot = input.dotSize ?? 12;
  const anchor = input.anchor ?? { x: sel.x + sel.w, y: sel.y + sel.h };
  const anchorX = Math.min(Math.max(anchor.x, sel.x), sel.x + sel.w);

  const x = clampX(anchorX - Math.round(size.w / 2), size.w, area);
  const below: Rect = { x, y: sel.y + sel.h + gap, w: size.w, h: size.h };
  const above: Rect = { x, y: sel.y - gap - size.h, w: size.w, h: size.h };

  const fits = (r: Rect) => r.y >= area.y && r.y + r.h <= area.y + area.h;
  const free = (r: Rect) => fits(r) && !obstacles.some((o) => intersects(r, o, MARGIN));

  if (free(below)) return { mode: 'pill', side: 'below', rect: below };
  if (free(above)) return { mode: 'pill', side: 'above', rect: above };

  // Both sides taken: a dot just past the end of the selection, on its last line.
  const dotRect: Rect = {
    x: clampX(anchorX + 4, dot, area),
    y: Math.min(Math.max(anchor.y - Math.round(dot / 2), sel.y), sel.y + sel.h - dot),
    w: dot,
    h: dot,
  };
  return { mode: 'dot', side: 'end', rect: dotRect };
}

/** The expanded bar or panel: same rules, but never collapses to a dot. */
export function placeBar(input: Omit<PlacementInput, 'dotSize'>): Placement {
  const p = placePill(input);
  if (p.mode === 'pill') return p;
  const { selection: sel, size, workArea: area } = input;
  const gap = input.gap ?? 8;
  const x = clampX(sel.x + sel.w - size.w, size.w, area);
  const belowY = sel.y + sel.h + gap;
  const y = belowY + size.h <= area.y + area.h ? belowY : Math.max(area.y, sel.y - gap - size.h);
  return { mode: 'pill', side: y >= belowY ? 'below' : 'above', rect: { x, y, w: size.w, h: size.h } };
}
