// Events found in a selection (Step 19.2, decision 37). They come from the same call as tasks
// (`actions/promises.ts`): the model returns titles and times as written, code resolves the
// times and the people. Without a model, sentence patterns find them.
import { z } from 'zod';
import { canonicalize } from '../people/names';
import { resolvePerson } from '../people/resolve';
import type { PeopleRepo } from '../store/people';
import type { EventCandidate } from './types';
import { resolveEventTime } from './when';

export const ExtractedEventSchema = z.object({
  title: z.string().describe('2 to 8 words, such as "Lunch with Jordan" or "Design review".'),
  when: z.string().describe('The day and start time exactly as written ("Thursday 1pm", "Oct 20", "tomorrow 3-4pm"), or "".'),
  end: z.string().describe('The end time as written, or "".'),
  duration_minutes: z.number().describe('Its length when the text gives one ("an hour" is 60), else 0.'),
  location: z.string().describe('The place or meeting link as written, or "".'),
  people: z.array(z.string()).describe('Who else attends, as written. Never the user.'),
  confidence: z.number().describe('0 to 1.'),
});
export type ExtractedEvent = z.infer<typeof ExtractedEventSchema>;

const MAX_EVENTS = 3;
/** Rows at or above this confidence start selected. */
const SELECT_CONFIDENCE = 0.5;

/** Model or pattern events into panel rows: times resolved, people matched (exact only), duplicates dropped. */
export function toEventRows(events: ExtractedEvent[], people: PeopleRepo, sourceApp: string, now: Date): EventCandidate[] {
  const rows: EventCandidate[] = [];
  const seen = new Set<string>();
  for (const [i, e] of events.entries()) {
    const title = e.title.replace(/\s+/g, ' ').trim();
    if (!title || rows.length >= MAX_EVENTS) continue;
    const time = e.when.trim() ? resolveEventTime({ when: e.when, end: e.end, minutes: e.duration_minutes }, now) : null;
    const dupe = `${canonicalize(title)}|${time?.starts_at ?? ''}`;
    if (seen.has(dupe)) continue;
    seen.add(dupe);
    const attendees = [...new Set(e.people.map((p) => p.replace(/\s+/g, ' ').trim()).filter(Boolean))].slice(0, 20);
    const matched: EventCandidate['people'] = [];
    for (const name of attendees) {
      const r = resolvePerson(people, { name }, sourceApp);
      const p = r.kind === 'exact' ? people.get(r.personId) : null;
      if (p && !matched.some((m) => m.personId === p.id)) matched.push({ personId: p.id, name: p.name });
    }
    const confidence = Math.min(1, Math.max(0, e.confidence > 1 ? e.confidence / 100 : e.confidence));
    rows.push({
      key: `e${i}`,
      title: title.slice(0, 200),
      starts_at: time?.starts_at ?? null,
      ends_at: time?.ends_at ?? null,
      all_day: time?.all_day ?? true,
      when_phrase: e.when.trim() || null,
      location: e.location.trim() || null,
      attendees,
      people: matched,
      confidence,
      // A row with no readable day can't be saved until the user picks one.
      selected: Boolean(time) && confidence >= SELECT_CONFIDENCE,
    });
  }
  return rows;
}

// ---- without a model ----

/** Words that make a dated sentence an event on their own. */
const STRONG =
  /\b(meeting|lunch|dinner|breakfast|brunch|coffee|drinks|appointment|interview|demo|workshop|webinar|party|flight|reservation|standup|stand-up|1:1|one-on-one|catch up|catch-up|concert)\b/i;
/** Every word that names an event; the weak ones ("call", "review") count only next to a clock time. */
export const MEETING =
  /\b(meeting|lunch|dinner|breakfast|brunch|coffee|drinks|appointment|interview|demo|workshop|webinar|party|flight|reservation|standup|stand-up|1:1|one-on-one|catch up|catch-up|concert|meet|call|sync|review|presentation|session|class|game)\b/i;
/** Deadline words: with a time but no meeting word, the sentence is a task ("send it by Friday 5pm"). */
const DEADLINE = /\b(?:by|before|until|due|deadline|send|submit|finish)\b/i;
const CLOCK = /\b\d{1,2}(?::\d{2})?\s*(?:-|–|to)?\s*\d{0,2}(?::\d{2})?\s*[ap]\.?m\.?\b|\b(?:[01]?\d|2[0-3]):[0-5]\d\b|\bnoon\b/i;
const DAY =
  /\b(?:today|tonight|tomorrow|(?:this |next )?(?:mon|tues?|wed(?:nes)?|thu(?:rs)?|fri|sat(?:ur)?|sun)(?:day)?|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.? \d{1,2}(?:st|nd|rd|th)?|\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)\b/i;
const LOCATION = /\b(?:at|in)\s+((?:the\s+)?[A-Z][\w'&.-]*(?:\s+(?:[A-Z][\w'&.-]*|\d+))*)/;
const NOT_PLACES = /^(?:the\s+)?(?:mon|tue|wed|thu|fri|sat|sun|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|noon|today|tomorrow)/i;

/**
 * True when a sentence reads like an event: a day plus a strong meeting word ("lunch"), or a day
 * and a clock time with a meeting word or without deadline words.
 */
export function isEventSentence(s: string): boolean {
  if (!DAY.test(s)) return false;
  if (STRONG.test(s)) return true;
  return CLOCK.test(s) && (MEETING.test(s) || !DEADLINE.test(s));
}

/**
 * Events by patterns: each sentence with a day and a time or meeting word. The title is the
 * meeting word (with the author, when someone else wrote it), the place follows "at" or "in".
 */
export function rulesEvents(text: string, author: { name: string | null; isMe: boolean }): ExtractedEvent[] {
  const out: ExtractedEvent[] = [];
  const sentences = text
    .replace(/[’‘]/g, "'")
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
  for (const sentence of sentences) {
    if (!isEventSentence(sentence)) continue;
    const day = DAY.exec(sentence)![0];
    const clock = CLOCK.exec(sentence)?.[0] ?? '';
    const meeting = (STRONG.exec(sentence) ?? (clock ? MEETING.exec(sentence) : null))?.[1];
    const withWhom = !author.isMe && author.name ? ` with ${author.name.split(' ')[0]}` : '';
    const title = meeting ? `${meeting[0]!.toUpperCase()}${meeting.slice(1).toLowerCase()}${withWhom}` : sentence.split(/\s+/).slice(0, 6).join(' ');
    const place = LOCATION.exec(sentence)?.[1];
    out.push({
      title,
      when: `${day} ${clock}`.trim(),
      end: '',
      duration_minutes: 0,
      location: place && !NOT_PLACES.test(place) ? place : '',
      people: !author.isMe && author.name ? [author.name] : [],
      confidence: clock && meeting ? 0.6 : 0.4,
    });
  }
  return out;
}
