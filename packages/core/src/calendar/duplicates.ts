// Is this event or task already saved? (decision 78). Rules first: an event must sit in the same
// slot (overlapping times, or the same day when either is all day), and its title must share a
// distinctive word with the saved one ("Lunch with Jordan" and "Jordan lunch" share "jordan";
// "Lunch with Casey" shares only "lunch", which doesn't count). Meaning breaks ties only when it's
// very close: on all-MiniLM-L6-v2, real matches like "Interview with Northwind" and "Northwind
// design interview" scored 0.885 and up, while different events in the same slot scored up to
// 0.55 ("Lunch with Jordan" and "Lunch with Casey") and some true matches as low as 0.47
// ("Call with Jordan Hale" and "Jordan 1:1"), so meaning alone can't decide (Oct 15).
import type { CommitmentView } from '../people/types';
import { canonicalize } from '../people/names';
import type { CalendarEvent } from './types';
import { DEFAULT_MINUTES } from './when';

/** Similarity of `a` to each of `b` (cosine, 1 = identical); from the local embedder. */
export type Similarity = (a: string, b: string[]) => Promise<number[]>;

/** Very close in meaning counts even without a shared word (see above). */
export const DUPLICATE_SIMILARITY = 0.85;

const STOP = new Set('a an the and or with w to for of on in at by my our your their his her its me us them from about'.split(' '));
/** Kinds of event and task words: shared alone, they don't make two titles the same thing. */
const GENERIC = new Set(
  'lunch dinner breakfast brunch coffee drinks call calls meeting meet sync catch up catchup chat review interview flight trip appointment appt session standup stand 1 2 1on1 team event party plan planning prep follow followup send email reply check update'.split(
    ' ',
  ),
);

/** The words of a title or task, lowercased, possessives and stop words dropped. */
export function titleWords(s: string): string[] {
  return canonicalize(s)
    .replace(/'s\b/g, '')
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w && !STOP.has(w));
}

/**
 * Same thing by its words: at least one distinctive word shared, and shared words making half of
 * the shorter title (events: "Jordan 1:1" is the call with Jordan Hale) or of the longer one
 * (tasks, which lead with verbs: "Renew car insurance" isn't "Renew passport").
 */
export function titlesMatch(a: string, b: string, of: 'shorter' | 'longer' = 'shorter'): boolean {
  const A = new Set(titleWords(a));
  const B = new Set(titleWords(b));
  if (!A.size || !B.size) return false;
  const shared = [...A].filter((w) => B.has(w));
  const base = of === 'shorter' ? Math.min(A.size, B.size) : Math.max(A.size, B.size);
  return shared.some((w) => !GENERIC.has(w)) && shared.length / base >= 0.5;
}

type Slot = Pick<CalendarEvent, 'starts_at' | 'ends_at' | 'all_day'>;
const span = (e: Slot): [number, number] => {
  const start = new Date(e.starts_at).getTime();
  return [start, e.ends_at ? new Date(e.ends_at).getTime() : start + DEFAULT_MINUTES * 60_000];
};

/** The same day, and overlapping times when both have them. */
export function sameSlot(a: Slot, b: Slot): boolean {
  if (a.starts_at.slice(0, 10) !== b.starts_at.slice(0, 10)) return false;
  if (a.all_day || b.all_day) return true;
  const [s1, e1] = span(a);
  const [s2, e2] = span(b);
  return s1 < e2 && s2 < e1;
}

/** A saved event that's the same as `c`, or null. `existing` is that day's events. */
export async function findDuplicateEvent(c: Slot & { title: string }, existing: CalendarEvent[], similarity?: Similarity): Promise<CalendarEvent | null> {
  const slot = existing.filter((e) => sameSlot(c, e));
  const byWords = slot.find((e) => titlesMatch(c.title, e.title));
  if (byWords || !slot.length || !similarity) return byWords ?? null;
  // Meaning only between timed events in the same slot: an all-day one is too loose a match.
  const timed = slot.filter((e) => !e.all_day && !c.all_day);
  if (!timed.length) return null;
  const sims = await similarity(c.title, timed.map((e) => e.title)).catch(() => []);
  const best = sims.reduce((bi, s, i) => (s > (sims[bi] ?? -1) ? i : bi), 0);
  return (sims[best] ?? 0) >= DUPLICATE_SIMILARITY ? timed[best]! : null;
}

/** An open task that's the same as `t`: the same person (or none), and the same thing by its words. */
export function findDuplicateTask(t: { text: string; person_id: string | null }, open: CommitmentView[]): CommitmentView | null {
  return open.find((o) => o.status === 'open' && o.person_id === t.person_id && titlesMatch(t.text, o.text, 'longer')) ?? null;
}
