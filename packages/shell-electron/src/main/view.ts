// Pure helpers for the overlay: slot labels and geometry. No Electron imports, so they are unit-tested.
import type { ActionId, AvailableAction, Point, Rect, RouteResult, Size, SlotsView, SlotView } from '@glossly/core';

export const ACTION_LABELS: Record<ActionId, string> = {
  ask: 'Ask',
  save: 'Save',
  reply: 'Reply',
  who: 'Who is this',
  promises: 'What did I promise',
  visualize: 'Visualize',
};

const AVAILABLE: readonly AvailableAction[] = ['ask', 'save'];
export const isAvailable = (a: ActionId): a is AvailableAction => (AVAILABLE as readonly string[]).includes(a);

function slot(action: ActionId, score?: number): SlotView {
  return { action, label: ACTION_LABELS[action], ...(score !== undefined && { score }), available: isAvailable(action) };
}

export function slotsView(r: RouteResult, stage: SlotsView['stage']): SlotsView {
  const collection = r.decisions.best_collection;
  return {
    slot1: slot('ask'),
    slot2: { ...slot('save'), label: `Save to ${collection}`, collection },
    slot3: r.slots.slot3 ? slot(r.slots.slot3.action, r.slots.slot3.score) : null,
    slot4: r.slots.slot4 ? slot(r.slots.slot4.action, r.slots.slot4.score) : null,
    more: r.slots.more.map((a) => slot(a.action, a.score)),
    stage,
    content_type: r.decisions.content_type,
    provider: r.decisions.provider,
    fallback: r.fallback,
    route_ms: Math.round(r.ms),
  };
}

/**
 * Slots 3 and 4 may fill in after the model answers, but slots 1 and 2 never change label
 * mid-session: the collection the user saw first stays.
 */
export function mergeRoute(prev: SlotsView, next: SlotsView): SlotsView {
  return { ...next, slot1: prev.slot1, slot2: prev.slot2 };
}

/** The action for a slot number, or null if the slot is empty. */
export function actionForSlot(s: SlotsView | null, n: 1 | 2 | 3 | 4): ActionId | null {
  if (n === 1) return 'ask';
  if (n === 2) return 'save';
  if (!s) return null;
  return (n === 3 ? s.slot3 : s.slot4)?.action ?? null;
}

export function clampRect(r: Rect, area: Rect): Rect {
  const x = Math.min(Math.max(r.x, area.x), area.x + area.w - r.w);
  const y = Math.min(Math.max(r.y, area.y), area.y + area.h - r.h);
  return { x: Math.round(x), y: Math.round(y), w: r.w, h: r.h };
}

/**
 * Grows the window from `from` to `size`, keeping its left edge and the edge next to the
 * selection fixed, so the buttons already on screen stay where they are.
 */
export function growFrom(from: Rect, side: 'below' | 'above' | 'end', size: Size, area: Rect): Rect {
  const y = side === 'above' ? from.y + from.h - size.h : from.y;
  return clampRect({ x: from.x, y, w: size.w, h: size.h }, area);
}

/** Distance from a point to the nearest edge of a rect; 0 inside. */
export function distanceToRect(p: Point, r: Rect): number {
  const dx = Math.max(r.x - p.x, 0, p.x - (r.x + r.w));
  const dy = Math.max(r.y - p.y, 0, p.y - (r.y + r.h));
  return Math.hypot(dx, dy);
}

export const contains = (r: Rect, p: Point) => p.x >= r.x && p.x < r.x + r.w && p.y >= r.y && p.y < r.y + r.h;
