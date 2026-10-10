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

const AVAILABLE: readonly AvailableAction[] = ['ask', 'save', 'who', 'promises', 'reply'];
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
 * Ask stays as first painted. Save's collection updates once, when the route settles,
 * unless the Save panel is already open. A contextual button already on screen is kept.
 */
export function mergeRoute(prev: SlotsView, next: SlotsView, opts?: { keepSave?: boolean }): SlotsView {
  const saveSettled = prev.stage === 'model' || prev.stage === 'rules_fallback';
  return {
    ...next,
    slot1: prev.slot1,
    slot2: opts?.keepSave || saveSettled ? prev.slot2 : next.slot2,
    slot3: shownSlot(prev.slot3, next.slot3),
    slot4: shownSlot(prev.slot4, next.slot4),
    more: shownMore(prev.more, next.more),
  };
}

/** Slots 3 and 4 stay empty while a model route is in flight, so a rules guess cannot flash and vanish. */
export function holdForRoute(view: SlotsView): SlotsView {
  return { ...view, slot3: null, slot4: null, more: [], stage: 'pending' };
}

function shownSlot(prev: SlotView | null, next: SlotView | null): SlotView | null {
  if (!prev) return next;
  if (!next || prev.action !== next.action) return prev;
  return next;
}

function shownMore(prev: SlotView[], next: SlotView[]): SlotView[] {
  if (prev.length === 0) return next;
  const seen = new Set(prev.map((m) => m.action));
  return [...prev.map((p) => next.find((n) => n.action === p.action) ?? p), ...next.filter((n) => !seen.has(n.action))];
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
 * selection fixed, so the buttons already on screen stay where they are. Placement picked
 * the left edge with room for the widest bar (overlay.ts MAX_W), so the clamp only shifts
 * the window if something larger than that is asked for.
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

/** Activity that can dismiss the overlay. Blur closes a focused bar; the others close a pill. */
export type HideSignal = 'keyboard_activity' | 'wheel' | 'mouse_away' | 'foreground' | 'blur';

/**
 * Whether this signal should hide the overlay.
 * `settling` is the short window after the hotkey opens the bar: the keys that opened it
 * still count as keyboard activity, focus may not have landed, and a blur or a foreground
 * bounce in that window would hide a bar the user just opened. Wheel still hides an
 * unfocused pill (a scroll is not the hotkey).
 */
export function shouldHideOverlay(input: {
  signal: HideSignal;
  visible: boolean;
  /** The overlay has asked for focus. A focused bar closes on blur, not on the other signals. */
  focused: boolean;
  settling: boolean;
  /** Windows has actually given the overlay the foreground. */
  osFocused?: boolean;
  /** Foreground moved to the source window or to Glossly itself. */
  ownForeground?: boolean;
}): boolean {
  const { signal, visible, focused, settling, osFocused, ownForeground } = input;
  // A blur before the hotkey's focus lands is the window settling, not the user leaving.
  // Once the OS focus is there, a blur closes, so a click away is not swallowed.
  if (signal === 'blur') return !(settling && !osFocused);
  if (!visible || focused) return false;
  if (signal === 'wheel') return true;
  if (signal === 'foreground') return !ownForeground && !settling;
  return !settling;
}

/** An HWND from BrowserWindow.getNativeWindowHandle(), as the number the helper uses. */
export function hwndFromBuffer(buf: Buffer): number {
  return buf.length >= 8 ? Number(buf.readBigUInt64LE(0)) : buf.readUInt32LE(0);
}
