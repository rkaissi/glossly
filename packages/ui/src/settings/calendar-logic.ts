// Pure logic for the Calendar tab (Step 20.2, decision 40): where events sit in Week, how drags
// snap, the toolbar's titles, and the month grid. Unit-tested.
import type { CalendarEvent } from '@glossly/core/api';
import { splitStamp } from '../dates';
import { addDays, addMonths, diffDays, fromDay, monthOf, weekStart, type Day, type DayRange, type WeekStart } from '../controls/logic';

export type CalendarView = 'month' | 'week' | 'agenda';

/** Minutes in a day, and the smallest step a drag moves by. */
export const DAY_MIN = 1440;
export const STEP = 15;

export const toMinutes = (t: string): number => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
export const toClock = (m: number): string => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

/** The day an event starts on. */
export const eventDay = (e: Pick<CalendarEvent, 'starts_at'>): Day => splitStamp(e.starts_at).day;

/**
 * An event's span in minutes on its start day, as written: a missing end is an hour, an end on
 * a later day runs to midnight, and anything shorter than 15 minutes shows as 15.
 */
export function eventSpan(e: Pick<CalendarEvent, 'starts_at' | 'ends_at'>): { start: number; end: number } {
  const s = splitStamp(e.starts_at);
  const start = s.time ? toMinutes(s.time) : 0;
  const en = splitStamp(e.ends_at);
  const end = !en.time ? start + 60 : en.day > s.day ? DAY_MIN : toMinutes(en.time);
  return { start, end: Math.min(DAY_MIN, Math.max(end, start + STEP)) };
}

/**
 * Columns for one day's timed events, as Google Calendar draws them: events that overlap share
 * the width, each in the first free column of its overlapping group.
 */
export function layoutDay(items: { id: string; start: number; end: number }[]): Map<string, { col: number; cols: number }> {
  const out = new Map<string, { col: number; cols: number }>();
  const sorted = [...items].sort((a, b) => a.start - b.start || b.end - a.end);
  let group: { id: string; end: number; col: number }[] = [];
  let groupEnd = -1;
  const flush = () => {
    const cols = Math.max(1, ...group.map((g) => g.col + 1));
    for (const g of group) out.set(g.id, { col: g.col, cols });
    group = [];
  };
  for (const it of sorted) {
    if (it.start >= groupEnd && group.length) flush();
    const taken = new Set(group.filter((g) => g.end > it.start).map((g) => g.col));
    let col = 0;
    while (taken.has(col)) col++;
    group.push({ id: it.id, end: it.end, col });
    groupEnd = Math.max(groupEnd, it.end);
  }
  if (group.length) flush();
  return out;
}

/** A pointer's offset in the time grid, as minutes snapped to 15, inside the day. */
export const snapMinutes = (y: number, hourPx: number): number => Math.max(0, Math.min(DAY_MIN, Math.round((y / hourPx) * 4) * STEP));

/** "Oct 12 – 18", "Sep 28 – Oct 4", with the year when it isn't `today`'s. */
export function weekTitle(start: Day, today: Day): string {
  const end = addDays(start, 6);
  const year = end.slice(0, 4) === today.slice(0, 4) ? '' : `, ${end.slice(0, 4)}`;
  const md = (d: Day) => fromDay(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  return start.slice(5, 7) === end.slice(5, 7) ? `${md(start)} – ${Number(end.slice(8))}${year}` : `${md(start)} – ${md(end)}${year}`;
}

export const monthTitle = (day: Day): string => fromDay(day).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });

/** The days a month view shows: whole weeks from the week start on or before the 1st, through the last day of the month. */
export function monthDays(day: Day, ws: WeekStart = 1): Day[] {
  const first = monthOf(day);
  const start = weekStart(first, ws);
  const last = addDays(addMonths(first, 1), -1);
  const weeks = Math.ceil((diffDays(last, start) + 1) / 7);
  return Array.from({ length: weeks * 7 }, (_, i) => addDays(start, i));
}

/** Every day in a range, first to last. */
export const rangeDays = (r: DayRange): Day[] => Array.from({ length: diffDays(r.to, r.from) + 1 }, (_, i) => addDays(r.from, i));

/** The previous or next range of the same length (the Agenda's arrows). */
export function shiftRange(r: DayRange, dir: -1 | 1): DayRange {
  const len = diffDays(r.to, r.from) + 1;
  return { from: addDays(r.from, dir * len), to: addDays(r.to, dir * len) };
}

/** "45 min", "1 h", "1 h 30 min". */
export const durationLabel = (m: number): string => (m < 60 ? `${m} min` : m % 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m / 60} h`);

/**
 * One of four glass tints taken from the window's background (sky, periwinkle, lilac, blush),
 * the same for an event every time it's drawn.
 */
export function tint(id: string): 'sky' | 'peri' | 'lilac' | 'blush' {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return (['sky', 'peri', 'lilac', 'blush'] as const)[h % 4]!;
}
