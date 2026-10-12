import { createHash } from 'node:crypto';
// Pure helpers for the overlay: slot labels and geometry. No Electron imports, so they are unit-tested.
import type { ActionId, AvailableAction, Point, Rect, RouteResult, Size, Slots, SlotsView, SlotView } from '@glossly/core';

export const ACTION_LABELS: Record<ActionId, string> = {
  ask: 'Ask',
  save: 'Save',
  reply: 'Reply',
  who: 'Who is this',
  promises: 'Tasks and events',
  visualize: 'Visualize',
  search: 'Search',
  recall: 'Related',
  paste_list: 'Paste snippets',
  paste_summary: 'Write it for here',
};

const AVAILABLE: readonly AvailableAction[] = ['ask', 'save', 'who', 'promises', 'reply', 'visualize', 'search', 'recall', 'paste_list', 'paste_summary'];
/** Actions that read tier 2 when clicked: the ones that send or store the text around the selection. */
const TIER2: readonly ActionId[] = ['ask', 'save', 'who', 'promises', 'reply'];
export const needsTier2 = (a: ActionId) => TIER2.includes(a);
export const isAvailable = (a: ActionId): a is AvailableAction => (AVAILABLE as readonly string[]).includes(a);

function slot(action: ActionId, score?: number): SlotView {
  return { action, label: ACTION_LABELS[action], ...(score !== undefined && { score }), available: isAvailable(action) };
}

/**
 * The Save slot's label: "Save to Notes", or the collection alone ("People notes") when the whole
 * label wouldn't fit the 172 px slot next to a key chip (about 16 characters of Segoe UI at 13 px).
 * The tooltip always says "Save to …".
 */
export const SAVE_LABEL_MAX = 16;
export const saveLabel = (collection: string): string => (`Save to ${collection}`.length <= SAVE_LABEL_MAX ? `Save to ${collection}` : collection);

export function slotsView(r: RouteResult, stage: SlotsView['stage']): SlotsView {
  const collection = r.decisions.best_collection;
  return {
    slot1: slot('ask'),
    slot2: { ...slot('save'), label: saveLabel(collection), collection },
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

/** The bar with nothing selected: Ask, then Search and the paste actions under the slot rule. Save is hidden. */
export function emptySlotsView(slots: Slots): SlotsView {
  return {
    slot1: slot('ask'),
    slot2: { ...slot('save'), collection: '' },
    slot3: slots.slot3 ? slot(slots.slot3.action, slots.slot3.score) : null,
    slot4: slots.slot4 ? slot(slots.slot4.action, slots.slot4.score) : null,
    more: slots.more.map((a) => slot(a.action, a.score)),
    stage: 'rules',
    content_type: null,
    provider: null,
    fallback: null,
    route_ms: null,
  };
}

/**
 * Ask stays as first painted. Save's collection updates once, when the route settles,
 * unless the Save panel is already open. A contextual button already on screen is kept.
 */
export function mergeRoute(prev: SlotsView, next: SlotsView, opts?: { keepSave?: boolean }): SlotsView {
  const saveSettled = prev.stage === 'model' || prev.stage === 'rules_fallback';
  const slot3 = shownSlot(prev.slot3, next.slot3);
  let slot4 = shownSlot(prev.slot4, next.slot4);
  // A kept button and a new one can name the same action: show it once.
  if (slot4 && slot4.action === slot3?.action) slot4 = null;
  const inSlots = new Set([slot3?.action, slot4?.action]);
  // A button the route wanted but a kept one displaced goes to More rather than vanishing.
  const displaced = [next.slot3, next.slot4].filter((v): v is SlotView => v !== null && !inSlots.has(v.action));
  const more = shownMore(prev.more, [...displaced, ...next.more]);
  return {
    ...next,
    slot1: prev.slot1,
    slot2: opts?.keepSave || saveSettled ? prev.slot2 : next.slot2,
    slot3,
    slot4,
    more: more.filter((m, i) => !inSlots.has(m.action) && more.findIndex((o) => o.action === m.action) === i),
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

/** Moves `r` inside `area`, shrinking it first when it is larger (else it would hang off the left or top). */
export function clampRect(r: Rect, area: Rect): Rect {
  const w = Math.min(Math.max(r.w, 0), Math.max(area.w, 0));
  const h = Math.min(Math.max(r.h, 0), Math.max(area.h, 0));
  const x = Math.min(Math.max(r.x, area.x), area.x + area.w - w);
  const y = Math.min(Math.max(r.y, area.y), area.y + area.h - h);
  return { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) };
}

export interface FitLimits {
  minW: number;
  maxW: number;
  minH: number;
  maxH: number;
}

/**
 * The size the renderer asked for, within the limits and kept inside the work area: it grows
 * from `cur` like `growFrom`, and a window wider than the screen shrinks instead of hanging off.
 */
export function fitOnScreen(cur: Rect, w: number, h: number, area: Rect, above: boolean, limits: FitLimits): Rect {
  const size = { w: Math.min(Math.max(w, limits.minW), limits.maxW), h: Math.min(Math.max(h, limits.minH), limits.maxH) };
  return growFrom(cur, above ? 'above' : 'below', size, area);
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

/**
 * The height a window growing from `cur` toward `side` has inside the source window, or null
 * when the source is unknown, doesn't hold `cur`, or leaves less than `min` (then the screen is
 * the limit, as before).
 */
export function sourceRoom(cur: Rect, side: 'above' | 'below', source: Rect | null, min: number): number | null {
  if (!source || cur.y < source.y - 1 || cur.y + cur.h > source.y + source.h + 1) return null;
  const room = Math.floor(side === 'above' ? cur.y + cur.h - source.y : source.y + source.h - cur.y);
  return room >= min ? room : null;
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
/**
 * How far the cursor may go from the pill before it hides: the setting, or, when the pill
 * appeared farther away than that (placed past a toolbar), that distance plus half the setting,
 * so only moving away hides it (decision 55).
 */
export function mouseAwayLimit(startDistance: number, hideDistance: number): number {
  return Math.max(hideDistance, startDistance + hideDistance / 2);
}

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

/** A small map that forgets the least recently used entry once it holds `max`. */
export class Lru<K, V> {
  private readonly map = new Map<K, V>();
  constructor(private readonly max: number) {}

  get(key: K): V | undefined {
    const v = this.map.get(key);
    if (v !== undefined) {
      this.map.delete(key);
      this.map.set(key, v);
    }
    return v;
  }

  set(key: K, value: V): void {
    this.map.delete(key);
    this.map.set(key, value);
    if (this.map.size > this.max) this.map.delete(this.map.keys().next().value as K);
  }

  clear(): void {
    this.map.clear();
  }
}

/**
 * Reply's cache key for one highlight, hashed: the site or app, the selected text, and who wrote
 * it when that was detected (their email, handle, or name, or "me"). Kept simple on purpose: at
 * worst the same short message in two chats on one site shares drafts, and "None of these"
 * writes new ones. The window title is left out (unread counts change it), and so is the page
 * around the message (a reload changes it).
 */
export function replyCacheKey(input: { place: string; author: string | null; text: string }): string {
  const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
  return createHash('sha256')
    .update([input.place.toLowerCase(), input.author ? norm(input.author).toLowerCase() : '', norm(input.text)].join('\u0000'))
    .digest('hex');
}

/** An Lru whose entries also expire, for model answers that go stale (Reply's drafts). */
export class ExpiringLru<K, V> {
  private readonly lru: Lru<K, { value: V; at: number }>;
  constructor(
    max: number,
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now,
  ) {
    this.lru = new Lru(max);
  }

  get(key: K): V | undefined {
    const e = this.lru.get(key);
    if (!e) return undefined;
    if (this.now() - e.at > this.ttlMs) return undefined;
    return e.value;
  }

  set(key: K, value: V): void {
    this.lru.set(key, { value, at: this.now() });
  }

  clear(): void {
    this.lru.clear();
  }
}

const slotPair = (s: Slots): [string, string] => [s.slot3?.action ?? 'none', s.slot4?.action ?? 'none'];

/**
 * The model's slots 3 and 4 beside the ones the rules alone would show, for every routing the
 * model answered (decision 61): codes only. `agree` ignores the order of the two.
 */
export function routeComparison(r: RouteResult): Record<string, string | boolean> {
  if (!r.rules) return {};
  const [m3, m4] = slotPair(r.slots);
  const [r3, r4] = slotPair(r.rules.slots);
  return {
    model_slot3: m3,
    model_slot4: m4,
    rules_slot3: r3,
    rules_slot4: r4,
    rules_type: r.rules.decisions.content_type,
    agree: [m3, m4].sort().join() === [r3, r4].sort().join(),
    type_agree: r.decisions.content_type === r.rules.decisions.content_type,
  };
}

/** Where a clicked action was on the bar, and whether the model's and the rules' slots offered it (decision 61). */
export function clickedWhere(action: ActionId, view: SlotsView | null, route: RouteResult | null | undefined): Record<string, string | boolean> {
  const where = !view
    ? 'none'
    : view.slot1?.action === action
      ? 'slot1'
      : view.slot2?.action === action
        ? 'slot2'
        : view.slot3?.action === action
          ? 'slot3'
          : view.slot4?.action === action
            ? 'slot4'
            : 'more';
  if (!route?.rules) return { where };
  return { where, in_model: slotPair(route.slots).includes(action), in_rules: slotPair(route.rules.slots).includes(action) };
}
