// Pure logic behind our own controls (Step 20.1, decision 39): popover placement, menu keys
// and type-ahead, the month grid, date ranges, and times. Unit-tested; the components in this
// folder only wire it to the DOM.

export interface Rect {
  top: number;
  left: number;
  bottom: number;
  right: number;
}

export interface Placement {
  top: number;
  left: number;
  /** Set when neither side fits: the popover scrolls inside this height. */
  maxHeight: number | null;
  side: 'below' | 'above';
}

const MARGIN = 8;
const GAP = 6;

/**
 * Where a popover goes: below its anchor if it fits, else above if that fits, else on the
 * roomier side. There a list (`fit: 'scroll'`) scrolls inside the room it has; a picker
 * (`fit: 'shift'`) never scrolls: it slides toward the other side, over its anchor if it must,
 * and is capped only when the whole window is shorter than it (Rayan, Oct 14). Always inside the
 * viewport (the window), with an 8 px margin.
 */
export function placePopover(
  anchor: Rect,
  size: { w: number; h: number },
  viewport: { w: number; h: number },
  align: 'start' | 'end' | 'side' = 'start',
  fit: 'scroll' | 'shift' = 'scroll',
): Placement {
  if (align === 'side') return placeBeside(anchor, size, viewport);
  const below = viewport.h - MARGIN - (anchor.bottom + GAP);
  const above = anchor.top - GAP - MARGIN;
  let side: Placement['side'];
  let maxHeight: number | null = null;
  let top: number;
  if (fit === 'shift' && size.h > below && size.h > above) {
    side = below >= above ? 'below' : 'above';
    const room = viewport.h - 2 * MARGIN;
    const h = Math.min(size.h, room);
    if (size.h > room) maxHeight = Math.max(0, room);
    const wantedTop = side === 'below' ? anchor.bottom + GAP : anchor.top - GAP - h;
    top = Math.max(MARGIN, Math.min(wantedTop, viewport.h - MARGIN - h));
  } else if (size.h <= below || below >= above) {
    side = 'below';
    top = anchor.bottom + GAP;
    if (size.h > below) maxHeight = Math.max(0, below);
  } else {
    side = 'above';
    const h = Math.min(size.h, above);
    if (size.h > above) maxHeight = Math.max(0, above);
    top = anchor.top - GAP - h;
  }
  const wanted = align === 'end' ? anchor.right - size.w : anchor.left;
  const left = Math.max(MARGIN, Math.min(wanted, viewport.w - size.w - MARGIN));
  return { top, left, maxHeight, side };
}

/**
 * Beside the anchor (an event in the calendar): to its right if it fits, else to its left, else
 * over it at the right edge; top-aligned with it and kept inside the window.
 */
function placeBeside(anchor: Rect, size: { w: number; h: number }, viewport: { w: number; h: number }): Placement {
  const right = anchor.right + GAP;
  const left = right + size.w <= viewport.w - MARGIN ? right : anchor.left - GAP - size.w >= MARGIN ? anchor.left - GAP - size.w : viewport.w - MARGIN - size.w;
  const room = viewport.h - 2 * MARGIN;
  const h = Math.min(size.h, room);
  const top = Math.max(MARGIN, Math.min(anchor.top, viewport.h - MARGIN - h));
  return { top, left: Math.max(MARGIN, left), maxHeight: size.h > room ? room : null, side: 'below' };
}

/**
 * How tall the window must be for a popover of height `h` to fit below its anchor (the window
 * growing downward) or above it (growing upward, when the bar sits above the selection). The
 * overlay grows to the one that matches its direction. Null when it already fits.
 */
/** A list that scrolls is usable once this much of it shows (about four rows). */
export const LIST_MIN_H = 168;

/**
 * The window height a popover needs when it fits on neither side of its anchor, or null.
 * `usable` is how much of it must show: all of it for a calendar, which can't scroll; for a
 * list, LIST_MIN_H is enough, so a short list scrolls in place instead of growing the window
 * (decision 50).
 */
export function roomNeeded(anchor: Rect, h: number, viewportH: number, usable = h): { below: number; above: number } | null {
  const need = Math.min(h, usable);
  const roomBelow = viewportH - MARGIN - (anchor.bottom + GAP);
  const roomAbove = anchor.top - GAP - MARGIN;
  if (roomBelow >= need || roomAbove >= need) return null;
  return { below: Math.ceil(anchor.bottom + GAP + h + MARGIN), above: Math.ceil(viewportH - anchor.top + GAP + h + MARGIN) };
}

/** True when the anchor has scrolled out of the area that clips it (the popover then closes). */
export const anchorHidden = (anchor: Rect, clip: Rect): boolean => anchor.bottom < clip.top || anchor.top > clip.bottom;

// ---- menus ----

/** The next active index for a navigation key, skipping disabled items; null when the key isn't one. */
export function menuMove(key: string, active: number, disabled: readonly boolean[]): number | null {
  const n = disabled.length;
  if (!n) return null;
  const step = (from: number, dir: 1 | -1): number => {
    for (let i = 1; i <= n; i++) {
      const j = (((from + dir * i) % n) + n) % n;
      if (!disabled[j]) return j;
    }
    return active;
  };
  switch (key) {
    case 'ArrowDown':
      return step(active < 0 ? -1 : active, 1);
    case 'ArrowUp':
      return step(active < 0 ? n : active, -1);
    case 'Home':
      return step(-1, 1);
    case 'End':
      return step(n, -1);
    default:
      return null;
  }
}

/** Type-ahead: keys typed within 600 ms add up; the first enabled label starting with them wins. */
export function typeAhead(state: { typed: string; at: number }, key: string, now: number, labels: readonly string[], disabled: readonly boolean[]): { typed: string; at: number; index: number | null } {
  const typed = (now - state.at > 600 ? '' : state.typed) + key.toLowerCase();
  const index = labels.findIndex((l, i) => !disabled[i] && l.toLowerCase().startsWith(typed));
  return { typed, at: now, index: index < 0 ? null : index };
}

// ---- days ----

/** A local day as "YYYY-MM-DD". */
export type Day = string;

export const toDay = (d: Date): Day => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

export function fromDay(s: Day): Date {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y!, m! - 1, d!);
}

export const isDay = (s: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(s) && toDay(fromDay(s)) === s;

export const addDays = (day: Day, n: number): Day => {
  const d = fromDay(day);
  return toDay(new Date(d.getFullYear(), d.getMonth(), d.getDate() + n));
};

/** The first of the month `n` months after the one `day` is in. */
export const addMonths = (day: Day, n: number): Day => {
  const d = fromDay(day);
  return toDay(new Date(d.getFullYear(), d.getMonth() + n, 1));
};

export const monthOf = (day: Day): Day => `${day.slice(0, 7)}-01`;

/** Whole days from `b` to `a` (negative when `a` is earlier). */
export const diffDays = (a: Day, b: Day): number => Math.round((fromDay(a).getTime() - fromDay(b).getTime()) / 86_400_000);

/** The first day of a week: 1 Monday (the default), 0 Sunday (the `weekStart` setting). */
export type WeekStart = 0 | 1;

/** The first day of the week `day` is in. */
export const weekStart = (day: Day, ws: WeekStart = 1): Day => addDays(day, -((fromDay(day).getDay() - ws + 7) % 7));

/** Six weeks of days from the week start on or before the 1st of `month`, for a month grid. */
export function monthGrid(month: Day, ws: WeekStart = 1): Day[] {
  const start = weekStart(monthOf(month), ws);
  return Array.from({ length: 42 }, (_, i) => addDays(start, i));
}

export const monthLabel = (month: Day): string => fromDay(month).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

/** Weekday names in grid order: "Mon" to "Sun", or "Sun" to "Sat". */
export const weekdayNames = (ws: WeekStart = 1): string[] => Array.from({ length: 7 }, (_, i) => DAY_NAMES[(ws + i) % 7]!);

/** "Fri, Oct 17", with the year when it isn't `today`'s. */
export function dayLabel(day: Day, today: Day): string {
  const d = fromDay(day);
  const opts: Intl.DateTimeFormatOptions = { weekday: 'short', month: 'short', day: 'numeric' };
  if (day.slice(0, 4) !== today.slice(0, 4)) opts.year = 'numeric';
  return d.toLocaleDateString('en-US', opts);
}

/** The date picker's shortcuts: Today, Tomorrow, Next week (next Monday), and No date. */
export function dateShortcuts(today: Day, ws: WeekStart = 1): { label: string; day: Day | null; hint: string }[] {
  const weekday = (d: Day) => fromDay(d).toLocaleDateString('en-US', { weekday: 'short' });
  const tomorrow = addDays(today, 1);
  const nextWeek = addDays(weekStart(today, ws), 7);
  return [
    { label: 'Today', day: today, hint: weekday(today) },
    { label: 'Tomorrow', day: tomorrow, hint: weekday(tomorrow) },
    { label: 'Next week', day: nextWeek, hint: dayLabel(nextWeek, today) },
    { label: 'No date', day: null, hint: '' },
  ];
}

// ---- ranges ----

export interface DayRange {
  from: Day;
  to: Day;
}

/** The range picker's quick ranges. */
export function quickRanges(today: Day, ws: WeekStart = 1): { label: string; range: DayRange }[] {
  const mon = weekStart(today, ws);
  const first = monthOf(today);
  return [
    { label: 'Today', range: { from: today, to: today } },
    { label: 'This week', range: { from: mon, to: addDays(mon, 6) } },
    { label: 'Next 7 days', range: { from: today, to: addDays(today, 6) } },
    { label: 'Next week', range: { from: addDays(mon, 7), to: addDays(mon, 13) } },
    { label: 'This month', range: { from: first, to: addDays(addMonths(first, 1), -1) } },
    { label: 'Next 30 days', range: { from: today, to: addDays(today, 29) } },
    { label: 'Last 7 days', range: { from: addDays(today, -6), to: today } },
  ];
}

/** Two picked days in order (days compare as strings). */
export const ordered = (a: Day, b: Day): DayRange => (a <= b ? { from: a, to: b } : { from: b, to: a });

/** How a day draws in a range: its start, end, inside, or none. */
export function rangeRole(day: Day, range: DayRange | null): { start: boolean; end: boolean; inside: boolean } {
  if (!range) return { start: false, end: false, inside: false };
  return { start: day === range.from, end: day === range.to, inside: day > range.from && day < range.to };
}

/** "Oct 13 – Oct 19", "Oct 13" for one day, with years when they differ from `today`'s. */
export function rangeLabel(r: DayRange, today: Day): string {
  const fmt = (d: Day) => fromDay(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', ...(d.slice(0, 4) !== today.slice(0, 4) && { year: 'numeric' }) });
  return r.from === r.to ? fmt(r.from) : `${fmt(r.from)} – ${fmt(r.to)}`;
}

// ---- times ----

/** "HH:MM", 24-hour, as events store their times. */
export type Time = string;

/**
 * A typed time to "HH:MM": "3pm", "3:45p", "15:30", "1530", "9", "9 am", "noon", "midnight".
 * Without am or pm, 1 to 6 mean afternoon (people rarely mean 3 in the morning); null when unreadable.
 */
export function parseTime(input: string): Time | null {
  const s = input.trim().toLowerCase().replace(/\./g, '');
  if (s === 'noon') return '12:00';
  if (s === 'midnight') return '00:00';
  const m = /^(\d{1,2})(?::?(\d{2}))?\s*(a|p|am|pm)?$/.exec(s);
  if (!m) return null;
  let h = Number(m[1]);
  const min = Number(m[2] ?? 0);
  if (min > 59) return null;
  if (m[3]) {
    if (h < 1 || h > 12) return null;
    if (h === 12) h = 0;
    if (m[3].startsWith('p')) h += 12;
  } else if (h > 23) return null;
  else if (h >= 1 && h <= 6 && m[1]!.length === 1 && !m[2]) h += 12;
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

/** "HH:MM" to "3:45 PM". */
export function formatTime(t: Time): string {
  const [h, m] = t.split(':').map(Number);
  return `${(h! % 12) || 12}:${String(m).padStart(2, '0')} ${h! < 12 ? 'AM' : 'PM'}`;
}

/** Every 15 minutes of the day. */
export const TIME_STEPS: readonly Time[] = Array.from({ length: 96 }, (_, i) => `${String(Math.floor(i / 4)).padStart(2, '0')}:${String((i % 4) * 15).padStart(2, '0')}`);

/** The step at or just before `t`, for scrolling the list to it. */
export const nearestStep = (t: Time): Time => {
  const [h, m] = t.split(':').map(Number);
  return TIME_STEPS[h! * 4 + Math.floor(m! / 15)]!;
};

/** The same time plus `minutes`, capped at 23:45 (an end after a moved start). */
export function addMinutes(t: Time, minutes: number): Time {
  const [h, m] = t.split(':').map(Number);
  const total = Math.min(23 * 60 + 45, Math.max(0, h! * 60 + m! + minutes));
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}
