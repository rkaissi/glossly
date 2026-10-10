// Resolves due phrases ("Friday", "end of next week", "tomorrow 3pm") to dates against the
// current time in the local time zone (spec: Model providers, Date resolution). The model only
// returns the phrase; it never computes a date. Anything unresolved is null.
import { isoNow } from '../types';

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const WEEKDAY_ABBR: Record<string, number> = { sun: 0, mon: 1, tue: 2, tues: 2, wed: 3, thu: 4, thur: 4, thurs: 4, fri: 5, sat: 6 };
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const NUMBER_WORDS: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, couple: 2, few: 3 };
/** Parts of the day, as a time. */
const DAY_PARTS: Record<string, [number, number]> = { morning: [9, 0], noon: [12, 0], midday: [12, 0], afternoon: [14, 0], evening: [18, 0], tonight: [20, 0], night: [20, 0], eod: [17, 0], cob: [17, 0] };
const END_OF_DAY: [number, number] = [17, 0];

interface Day {
  y: number;
  m: number;
  d: number;
}

const dayOf = (dt: Date): Day => ({ y: dt.getFullYear(), m: dt.getMonth(), d: dt.getDate() });
const toDate = (day: Day) => new Date(day.y, day.m, day.d);
const addDays = (day: Day, n: number): Day => dayOf(new Date(day.y, day.m, day.d + n));
const pad = (n: number) => String(n).padStart(2, '0');
const dateString = (day: Day) => `${day.y}-${pad(day.m + 1)}-${pad(day.d)}`;

function weekdayIndex(word: string): number | null {
  const w = word.toLowerCase().replace(/\.$/, '');
  const full = WEEKDAYS.indexOf(w);
  if (full >= 0) return full;
  return WEEKDAY_ABBR[w] ?? null;
}

function monthIndex(word: string): number | null {
  const w = word.toLowerCase().replace(/\.$/, '');
  if (w.length < 3) return null;
  const i = MONTHS.findIndex((m) => m.startsWith(w) && (w.length >= 3 || m === w));
  return i >= 0 ? i : null;
}

/** The next given weekday on or after `from` (today counts). */
function nextWeekday(from: Day, wd: number): Day {
  const cur = toDate(from).getDay();
  return addDays(from, (wd - cur + 7) % 7);
}

/** Monday of the week that holds `day` (weeks run Monday to Sunday). */
function mondayOf(day: Day): Day {
  const wd = toDate(day).getDay();
  return addDays(day, -((wd + 6) % 7));
}

/** A time inside the phrase: "3pm", "3:30 pm", "15:00", "at noon". Returns [h, m] and the rest of the phrase. */
function takeTime(s: string): { time: [number, number] | null; rest: string } {
  let m = /\b(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m\.?\b/i.exec(s);
  if (m) {
    let h = Number(m[1]);
    const min = Number(m[2] ?? 0);
    if (h < 1 || h > 12 || min > 59) return { time: null, rest: s };
    if (m[3]!.toLowerCase() === 'p' && h !== 12) h += 12;
    if (m[3]!.toLowerCase() === 'a' && h === 12) h = 0;
    return { time: [h, min], rest: s.replace(m[0], ' ') };
  }
  m = /\b(?:at\s+)?([01]?\d|2[0-3]):([0-5]\d)\b/.exec(s);
  if (m) return { time: [Number(m[1]), Number(m[2])], rest: s.replace(m[0], ' ') };
  // "at 3" without am or pm: business hours, so 1 to 7 is the afternoon.
  m = /\bat\s+(\d{1,2})\b(?!\s*[:/])/i.exec(s);
  if (m && Number(m[1]) >= 1 && Number(m[1]) <= 12) {
    const h = Number(m[1]);
    return { time: [h <= 7 ? h + 12 : h, 0], rest: s.replace(m[0], ' ') };
  }
  m = /\b(?:at\s+|by\s+)?(noon|midday|midnight)\b/i.exec(s);
  if (m) return { time: m[1]!.toLowerCase() === 'midnight' ? [23, 59] : [12, 0], rest: s.replace(m[0], ' ') };
  return { time: null, rest: s };
}

function takeDayPart(s: string): { time: [number, number] | null; rest: string } {
  const m = /\b(?:in the |this |tomorrow )?(morning|afternoon|evening|tonight|night|eod|cob)\b/i.exec(s);
  if (!m) return { time: null, rest: s };
  const keepTomorrow = /^tomorrow /i.test(m[0]) ? 'tomorrow ' : '';
  const keepTonight = m[1]!.toLowerCase() === 'tonight' ? 'today ' : '';
  return { time: DAY_PARTS[m[1]!.toLowerCase()]!, rest: s.replace(m[0], ` ${keepTomorrow}${keepTonight}`) };
}

/** The day a phrase names, without its time. Null when it names none. */
function resolveDay(s: string, today: Day): { day: Day; time?: [number, number] } | null {
  const t = s.trim();
  if (!t) return null;
  if (/^(?:today|now|asap today)$/.test(t)) return { day: today };
  if (/^(?:tomorrow|tmrw|tmr)$/.test(t)) return { day: addDays(today, 1) };
  if (/^(?:the )?day after tomorrow$/.test(t)) return { day: addDays(today, 2) };

  // End of day, week, month.
  if (/^end of (?:the )?day$/.test(t)) return { day: today, time: END_OF_DAY };
  let m = /^(?:end of (?:the |this )?week|eow|this week)$/.exec(t);
  if (m) {
    const fri = addDays(mondayOf(today), 4);
    return { day: toDate(fri) < toDate(today) ? addDays(fri, 7) : fri, time: END_OF_DAY };
  }
  if (/^end of next week$/.test(t)) return { day: addDays(mondayOf(today), 11), time: END_OF_DAY };
  if (/^(?:end of (?:the |this )?month|eom)$/.test(t)) return { day: dayOf(new Date(today.y, today.m + 1, 0)) };
  if (/^end of next month$/.test(t)) return { day: dayOf(new Date(today.y, today.m + 2, 0)) };
  if (/^next week$/.test(t)) return { day: addDays(mondayOf(today), 7) };
  if (/^next month$/.test(t)) return { day: dayOf(new Date(today.y, today.m + 1, 1)) };

  // In N days or weeks.
  m = /^in (\d+|a|an|one|two|three|four|five|six|seven|eight|nine|ten|a couple of|a few) (day|week)s?$/.exec(t);
  if (m) {
    const word = m[1]!.replace(/^a (couple|few) of$/, '$1').replace(/^a (couple|few)$/, '$1');
    const n = /^\d+$/.test(word) ? Number(word) : NUMBER_WORDS[word.replace(/ of$/, '')] ?? null;
    if (n === null) return null;
    return { day: addDays(today, m[2] === 'week' ? n * 7 : n) };
  }

  // Weekdays: "friday" (next occurrence, today counts), "this friday", "next friday" (the one in next week).
  m = /^(this |next |coming |the coming )?([a-z]+\.?)$/.exec(t);
  if (m) {
    const wd = weekdayIndex(m[2]!);
    if (wd !== null) {
      const first = nextWeekday(today, wd);
      if (m[1]?.trim() !== 'next') return { day: first };
      // "next Friday" is the Friday of next week: never today, and never one in this week.
      const sameWeek = (a: Day) => dateString(mondayOf(a)) === dateString(mondayOf(today));
      return { day: sameWeek(first) ? addDays(first, 7) : first };
    }
  }

  // Explicit dates: 2026-10-14, 10/14, 10/14/2026, Oct 14, October 14th, 14 Oct, the 14th.
  m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(t);
  if (m) return valid(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  m = /^(\d{1,2})\/(\d{1,2})(?:\/(\d{2}|\d{4}))?$/.exec(t);
  if (m) return withYear(Number(m[1]) - 1, Number(m[2]), m[3], today);
  m = /^(?:[a-z]+,? )?([a-z]+\.?) (\d{1,2})(?:st|nd|rd|th)?(?:,? (\d{4}))?$/.exec(t);
  if (m && monthIndex(m[1]!) !== null) return withYear(monthIndex(m[1]!)!, Number(m[2]), m[3], today);
  m = /^(?:[a-z]+,? )?(?:the )?(\d{1,2})(?:st|nd|rd|th)?(?: of)? ([a-z]+\.?)(?:,? (\d{4}))?$/.exec(t);
  if (m && monthIndex(m[2]!) !== null) return withYear(monthIndex(m[2]!)!, Number(m[1]), m[3], today);
  m = /^the (\d{1,2})(?:st|nd|rd|th)$/.exec(t);
  if (m) {
    const d = Number(m[1]);
    const thisMonth = valid(today.y, today.m, d);
    if (thisMonth && toDate(thisMonth.day) >= toDate(today)) return thisMonth;
    return valid(today.y, today.m + 1, d);
  }
  return null;
}

function valid(y: number, m: number, d: number): { day: Day } | null {
  const dt = new Date(y, m, d);
  if (dt.getMonth() !== ((m % 12) + 12) % 12 || dt.getDate() !== d) return null;
  return { day: dayOf(dt) };
}

/** A month and day without a year: this year, unless that is more than a week ago (then next year). */
function withYear(m: number, d: number, year: string | undefined, today: Day): { day: Day } | null {
  if (year) return valid(year.length === 2 ? 2000 + Number(year) : Number(year), m, d);
  const r = valid(today.y, m, d);
  if (!r) return null;
  if (toDate(r.day).getTime() < toDate(addDays(today, -7)).getTime()) return valid(today.y + 1, m, d);
  return r;
}

/**
 * "YYYY-MM-DD" for a day, a full ISO 8601 timestamp with the local offset when the phrase has a
 * time ("tomorrow 3pm", "end of week" = Friday 17:00), or null when it can't be resolved.
 */
export function resolveDue(phrase: string | null | undefined, now: Date = new Date()): string | null {
  if (!phrase) return null;
  let s = phrase
    .toLowerCase()
    .replace(/[’']/g, "'")
    .replace(/[,;!?]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  // Leading words that don't change the date.
  s = s.replace(/^(?:due|by|before|on|until|till|no later than|sometime|some time|latest|at the latest)\s+/g, '').replace(/^(?:by|on|before)\s+/, '');
  s = s.replace(/\s+(?:at the latest|latest)$/, '');
  if (!s) return null;
  const today = dayOf(now);

  const part = takeDayPart(s);
  const clock = takeTime(part.rest);
  const rest = clock.rest.replace(/\b(?:at|on|by)\b/g, ' ').replace(/\s+/g, ' ').trim();
  const time = clock.time ?? part.time;

  let resolved = rest ? resolveDay(rest, today) : null;
  if (!resolved) {
    if (rest || !time) return null;
    // A time alone ("3pm", "tonight"): today if it's still ahead, else tomorrow.
    const at = new Date(today.y, today.m, today.d, time[0], time[1]);
    resolved = { day: at > now || part.time ? today : addDays(today, 1) };
  }
  const t = time ?? resolved.time;
  if (!t) return dateString(resolved.day);
  return isoNow(new Date(resolved.day.y, resolved.day.m, resolved.day.d, t[0], t[1]));
}
