import type { Point, Rect } from '../types';

export interface Size {
  w: number;
  h: number;
}

export interface Placement {
  mode: 'pill' | 'dot';
  side: 'below' | 'above' | 'end';
  /** The window. */
  rect: Rect;
  /** Dot mode: the visible dot inside `rect`, in the same space. The rest of the window is click-through. */
  mark?: Rect;
}

export interface PlacementInput {
  /** Selection bounds. Same coordinate space as everything else (DIP in the shell). */
  selection: Rect;
  /** Where the selection ends, usually the mouse-up point. Defaults to the bottom-right corner. */
  anchor?: Point;
  /**
   * The selection's last line, from the helper. The dot goes just past its end instead of near the
   * mouse-up point, which can be mid-word or out past a shorter last line (decision 44).
   */
  lastLine?: Rect | null;
  /** Toolbars and popups from popups_near. */
  obstacles: Rect[];
  size: Size;
  workArea: Rect;
  /**
   * The widest the window can grow to the right (the bar with both slots at the label cap, or
   * a panel). The window only grows rightward from its left edge, so the left edge is picked
   * now, at first paint, with room for this width; nothing has to shift later. Defaults to
   * `size.w`.
   */
  growW?: number;
  gap?: number;
  /** Diameter of the visible dot. */
  dotSize?: number;
  /**
   * The dot's window. Windows won't shrink the overlay below about 29x38 DIP, so the dot is
   * drawn at a fixed spot inside a larger window instead of filling it.
   */
  dotWindow?: Size;
}

const MARGIN = 6;
/** Room left of the dot inside its window, for its shadow. */
const DOT_PAD = 6;
/** Space between the end of the last selected line and the dot. */
const DOT_GAP = 3;

function intersects(a: Rect, b: Rect, margin = 0): boolean {
  return a.x - margin < b.x + b.w && b.x < a.x + a.w + margin && a.y - margin < b.y + b.h && b.y < a.y + a.h + margin;
}

function clampX(x: number, w: number, area: Rect): number {
  return Math.min(Math.max(x, area.x), area.x + area.w - w);
}

/** Like clampX, but leaves room on the right for the window to grow to `reach`. */
function leftEdge(x: number, w: number, reach: number, area: Rect): number {
  return Math.max(area.x, Math.min(clampX(x, w, area), area.x + area.w - Math.max(w, reach)));
}

/**
 * Places the pill near the end of the selection without covering the app's own toolbar:
 * below by default, above if something is below (or there is no room), and a small dot at
 * the end of the selection if both sides are taken.
 */
export function placePill(input: PlacementInput): Placement {
  const { selection: sel, size, workArea: area, obstacles } = input;
  const gap = input.gap ?? 8;
  const dot = input.dotSize ?? 18;
  const dotWin = input.dotWindow ?? { w: 40, h: 40 };
  const anchor = input.anchor ?? { x: sel.x + sel.w, y: sel.y + sel.h };
  const anchorX = Math.min(Math.max(anchor.x, sel.x), sel.x + sel.w);

  const x = leftEdge(anchorX - Math.round(size.w / 2), size.w, input.growW ?? size.w, area);
  const below: Rect = { x, y: sel.y + sel.h + gap, w: size.w, h: size.h };
  const above: Rect = { x, y: sel.y - gap - size.h, w: size.w, h: size.h };

  const fits = (r: Rect) => r.y >= area.y && r.y + r.h <= area.y + area.h;
  const free = (r: Rect) => fits(r) && !obstacles.some((o) => intersects(r, o, MARGIN));

  if (free(below)) return { mode: 'pill', side: 'below', rect: below };
  if (free(above)) return { mode: 'pill', side: 'above', rect: above };

  // Both sides taken: a dot just past the end of the selection, centered on its last line.
  // The window extends right and down from the dot, the directions Windows grows it in if it
  // enforces a larger minimum size, so the dot's offset inside it stays put.
  const line = input.lastLine;
  const endX = line ? line.x + line.w + DOT_GAP : anchorX + 4;
  const endY = line ? line.y + Math.round(line.h / 2) : anchor.y;
  const offY = Math.round((dotWin.h - dot) / 2);
  const markY = Math.min(Math.max(endY - Math.round(dot / 2), sel.y), sel.y + sel.h - dot);
  const win: Rect = {
    x: clampX(endX - DOT_PAD, dotWin.w, area),
    y: Math.min(Math.max(markY - offY, area.y), area.y + area.h - dotWin.h),
    w: dotWin.w,
    h: dotWin.h,
  };
  return { mode: 'dot', side: 'end', rect: win, mark: { x: win.x + DOT_PAD, y: win.y + offY, w: dot, h: dot } };
}

/** The expanded bar or panel: same rules, but never collapses to a dot. */
export function placeBar(input: Omit<PlacementInput, 'dotSize' | 'dotWindow'>): Placement {
  const p = placePill(input);
  if (p.mode === 'pill') return p;
  const { selection: sel, size, workArea: area } = input;
  const gap = input.gap ?? 8;
  const x = leftEdge(sel.x + sel.w - size.w, size.w, input.growW ?? size.w, area);
  const belowY = sel.y + sel.h + gap;
  const y = belowY + size.h <= area.y + area.h ? belowY : Math.max(area.y, sel.y - gap - size.h);
  return { mode: 'pill', side: y >= belowY ? 'below' : 'above', rect: { x, y, w: size.w, h: size.h } };
}
