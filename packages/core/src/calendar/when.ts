// When an event happens (Step 19.2): the model, or the patterns, return the day and times as
// written ("Thursday 1-2pm", "tomorrow at 3", "Oct 20"); code resolves them, like due phrases.
import { parseClock, resolveDue } from '../people/dates';
import { isoNow } from '../types';

/** Length of a timed event when nothing says how long it is. */
export const DEFAULT_MINUTES = 60;

const RANGE = /\b(\d{1,2})(?::(\d{2}))?\s*([ap])?\.?(m\.?)?\s*(?:-|–|—|to|until|till)\s*(\d{1,2})(?::(\d{2}))?\s*([ap])?\.?(?:m\.?)?(?![\w/])/i;

/**
 * Splits a time range out of a phrase: "Thursday 1-2pm" is "Thursday 1pm" to "2pm". A start
 * without am or pm takes the end's ("1-2pm"), unless that would put it after the end ("11-1pm"
 * starts in the morning). Needs am, pm, or minutes on one side, so "10-14" stays a date.
 */
export function splitRange(phrase: string): { start: string; end: string | null } {
  const m = RANGE.exec(phrase);
  if (!m) return { start: phrase, end: null };
  const [all, h1, m1, ap1, , h2, m2, ap2] = m;
  if (!ap1 && !ap2 && !m1 && !m2) return { start: phrase, end: null };
  let startAp = ap1?.toLowerCase();
  const endAp = ap2?.toLowerCase();
  if (!startAp && endAp) {
    const a = Number(h1) % 12;
    const b = Number(h2) % 12;
    startAp = endAp === 'p' && Number(h1) !== 12 && a > b ? 'a' : endAp;
  }
  const clock = (h: string, min: string | undefined, ap: string | undefined) => `${h}${min ? `:${min}` : ''}${ap ? `${ap}m` : ''}`;
  return { start: phrase.replace(all!, clock(h1!, m1, startAp)).trim(), end: clock(h2!, m2, endAp) };
}

export interface EventTime {
  /** "YYYY-MM-DD" for an all-day event, else an ISO timestamp with the local offset. */
  starts_at: string;
  ends_at: string | null;
  all_day: boolean;
}

/**
 * Resolves an event's time. `when` holds the day and start ("Thursday 1pm", "Oct 20", "1-2pm
 * tomorrow"); `end` an end time as written; `minutes` a length the text gave (0 for none). A day
 * with no time is all day. A timed event without an end lasts `DEFAULT_MINUTES`. Null when the
 * day can't be read.
 */
export function resolveEventTime(input: { when: string; end?: string; minutes?: number }, now: Date = new Date()): EventTime | null {
  const { start, end: rangeEnd } = splitRange(input.when.trim());
  const starts_at = resolveDue(start, now);
  if (!starts_at) return null;
  if (!starts_at.includes('T')) return { starts_at, ends_at: null, all_day: true };

  const begin = new Date(starts_at);
  const endPhrase = input.end?.trim() || rangeEnd;
  let finish: Date | null = null;
  const clock = endPhrase ? parseClock(endPhrase) : null;
  if (clock) {
    finish = new Date(begin);
    finish.setHours(clock[0], clock[1], 0, 0);
    // "2 to 4" with no am or pm: an end before the start is in the afternoon.
    if (finish <= begin && clock[0] < 12 && !/[ap]\.?m/i.test(endPhrase!)) finish.setHours(clock[0] + 12);
    if (finish <= begin) finish = null;
  }
  if (!finish && input.minutes && input.minutes > 0) finish = new Date(begin.getTime() + Math.min(input.minutes, 24 * 60) * 60_000);
  finish ??= new Date(begin.getTime() + DEFAULT_MINUTES * 60_000);
  return { starts_at, ends_at: isoNow(finish), all_day: false };
}
