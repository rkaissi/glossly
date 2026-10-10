import type { CommandResult } from '../helper/protocol';
import type { Rect } from '../types';

export type Popup = CommandResult<'popups_near'>['popups'][number];

/**
 * Why an obstacle does or doesn't count. Only `new` ones move the pill:
 * - `preexisting`: in the mouse-down baseline with the same id and bounds (app chrome, a
 *   menu bar, an unrelated always-on-top window), so it did not appear for this selection.
 * - `tooltip`: transient, never worth moving the pill for.
 * - `covers_selection`: contains the whole selection, so the user could see the text through
 *   it (a transparent overlay) or the selection is inside it; either way it is not beside it.
 */
export type ObstacleStatus = 'new' | 'preexisting' | 'tooltip' | 'covers_selection';

export interface ClassifiedObstacle {
  popup: Popup;
  status: ObstacleStatus;
  side: 'above' | 'below' | 'overlap';
}

const sameRect = (a: Rect, b: Rect) => a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;

const containsRect = (outer: Rect, inner: Rect) =>
  outer.x <= inner.x && outer.y <= inner.y && outer.x + outer.w >= inner.x + inner.w && outer.y + outer.h >= inner.y + inner.h;

function inBaseline(p: Popup, baseline: readonly Popup[]): boolean {
  return baseline.some(
    (b) =>
      b.source === p.source &&
      b.kind === p.kind &&
      sameRect(b.bounds, p.bounds) &&
      (p.id && b.id ? b.id === p.id : b.class_name === p.class_name),
  );
}

function sideOf(r: Rect, sel: Rect): ClassifiedObstacle['side'] {
  if (r.y + r.h <= sel.y) return 'above';
  if (r.y >= sel.y + sel.h) return 'below';
  return 'overlap';
}

/**
 * Sorts what popups_near found near `selection`. `baseline` is the snapshot taken at the
 * selection's mouse-down, or null if there is none (then everything that isn't a tooltip or
 * covering the selection counts, as before). All rects in one coordinate space.
 */
export function classifyObstacles(found: readonly Popup[], baseline: readonly Popup[] | null, selection: Rect): ClassifiedObstacle[] {
  return found.map((popup) => {
    const status: ObstacleStatus =
      popup.kind === 'tooltip'
        ? 'tooltip'
        : containsRect(popup.bounds, selection)
          ? 'covers_selection'
          : baseline && inBaseline(popup, baseline)
            ? 'preexisting'
            : 'new';
    return { popup, status, side: sideOf(popup.bounds, selection) };
  });
}
