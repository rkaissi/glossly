// How retrieved context reads in a prompt, and in the "Used N" chip (decision 77). Dates are
// worked out here, against the current time, so the model never has to decide whether an event
// is past or coming, or how many days are left on a task.
import type { ContextUsed } from '../api';
import type { ContextEvent, ContextPerson, ContextTask, RetrievedContext } from './retrieve';

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();
const MAX_PERSON_NOTE = 200;
const MAX_LINE = 200;

type Format = { format: (d: Date) => string };
/** Intl puts a narrow no-break space before AM and PM; prompts and the chip get a plain one. */
const ODD_SPACES = new RegExp(`[${String.fromCharCode(0x202f, 0xa0)}]`, 'g');
const plain = (f: Intl.DateTimeFormat): Format => ({ format: (d) => f.format(d).replace(ODD_SPACES, ' ') });
let fmt: { day: Format; time: Format; full: Format; short: Format } | null = null;
const formats = () =>
  (fmt ??= {
    day: plain(new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric' })),
    time: plain(new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' })),
    full: plain(new Intl.DateTimeFormat('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })),
    short: plain(new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' })),
  });

/** A stored day ("YYYY-MM-DD") or timestamp as a local Date; a bare day is noon, away from DST edges. */
const parse = (s: string) => new Date(s.length === 10 ? `${s}T12:00:00` : s);
const midnight = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
/** Whole calendar days from today to `d` (negative in the past). */
const daysFrom = (now: Date, d: Date) => Math.round((midnight(d).getTime() - midnight(now).getTime()) / 86_400_000);

/** "today", "tomorrow", "yesterday", or "Fri, Oct 16 (in 2 days)" / "Mon, Oct 12 (2 days ago)". */
export function dayLabel(d: Date, now: Date): string {
  const n = daysFrom(now, d);
  if (n === 0) return 'today';
  if (n === 1) return 'tomorrow';
  if (n === -1) return 'yesterday';
  return `${formats().day.format(d)} (${n > 0 ? `in ${n} days` : `${-n} days ago`})`;
}

/** "in 3 hours", "in 40 minutes": how soon something today starts. */
function soon(ms: number): string {
  const min = Math.round(ms / 60_000);
  if (min < 60) return `in ${Math.max(min, 1)} minutes`;
  const h = Math.round(min / 60);
  return `in ${h} hour${h === 1 ? '' : 's'}`;
}

/** "today, 1:00 PM to 5:00 PM, in 3 hours", "happening now", "yesterday, all day, past". */
export function eventLabel(e: Pick<ContextEvent, 'starts_at' | 'ends_at' | 'all_day'>, now: Date): string {
  const start = parse(e.starts_at);
  const { time } = formats();
  if (e.all_day) {
    const n = daysFrom(now, start);
    return `${dayLabel(start, now)}, all day${n < 0 ? ', past' : ''}`;
  }
  const end = e.ends_at ? parse(e.ends_at) : new Date(start.getTime() + 60 * 60_000);
  const span = e.ends_at
    ? `${time.format(start)} to ${daysFrom(start, end) === 0 ? time.format(end) : `${dayLabel(end, now)} ${time.format(end)}`}`
    : time.format(start);
  const t = now.getTime();
  const status = end.getTime() <= t ? 'past' : start.getTime() <= t ? 'happening now' : daysFrom(now, start) === 0 ? soon(start.getTime() - t) : null;
  return [dayLabel(start, now), span, status].filter(Boolean).join(', ');
}

/** "open, due tomorrow", "open, overdue by 3 days (was due Oct 11)", "open", "done Oct 13", "dropped". */
export function taskLabel(c: Pick<ContextTask, 'status' | 'due_at' | 'completed_at'>, now: Date): string {
  if (c.status === 'done') return c.completed_at ? `done ${formats().short.format(parse(c.completed_at))}` : 'done';
  if (c.status === 'dropped') return 'dropped';
  if (!c.due_at) return 'open';
  const due = parse(c.due_at);
  const n = daysFrom(now, due);
  const at = c.due_at.length > 10 ? ` at ${formats().time.format(due)}` : '';
  if (n < 0) return `open, overdue by ${-n} day${n === -1 ? '' : 's'} (was due ${formats().short.format(due)})`;
  return `open, due ${dayLabel(due, now)}${at}`;
}

/** Who owes whom, in the third person the prompts use. */
export function taskOwner(c: Pick<ContextTask, 'owner' | 'person_name'>): string {
  if (c.person_name) return c.owner === 'me' ? `The user owes ${c.person_name}` : `${c.person_name} owes the user`;
  return c.owner === 'me' ? "The user's own task" : 'Owed to the user';
}

/** "Wednesday, October 14, 2026 at 10:05 AM (America/Toronto)": the prompts' sense of now. */
export function nowLine(now: Date): string {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return `${formats().full.format(now)}${zone ? ` (${zone})` : ''}`;
}

function personLine(p: ContextPerson): string {
  const about = [p.relationship, p.note ? clip(oneLine(p.note), MAX_PERSON_NOTE) : null].filter(Boolean).join('; ');
  return `- ${p.name}${about ? `: ${about}` : ''}`;
}

function eventLine(e: ContextEvent, now: Date): string {
  const extra = [e.location ? `at ${e.location}` : null, e.attendees.length ? `with ${e.attendees.join(', ')}` : null].filter(Boolean).join(', ');
  return clip(`- [${eventLabel(e, now)}] ${oneLine(e.title)}${extra ? ` (${extra})` : ''}`, MAX_LINE);
}

/**
 * The people, tasks, and events part of a prompt's saved-data section; empty when there are none.
 * Notes are left to each prompt, which labels them for citing.
 */
export function contextLines(ctx: Pick<RetrievedContext, 'people' | 'tasks' | 'events'>, now: Date): string[] {
  const out: string[] = [];
  if (ctx.people.length) out.push('People:', ...ctx.people.map(personLine));
  if (ctx.tasks.length) out.push('Tasks:', ...ctx.tasks.map((c) => clip(`- [${taskLabel(c, now)}] ${taskOwner(c)}: ${oneLine(c.text)}`, MAX_LINE)));
  if (ctx.events.length) out.push('Calendar:', ...ctx.events.map((e) => eventLine(e, now)));
  return out;
}

/** What went into the prompt, for the panel's "Used N" chip. Labels are short; nothing here is logged. */
export function contextUsed(ctx: Pick<RetrievedContext, 'people' | 'tasks' | 'events'>, notes: { id: string; text: string }[], now: Date): ContextUsed[] {
  return [
    ...notes.map((n): ContextUsed => ({ kind: 'note', id: n.id, label: clip(oneLine(n.text), 90), detail: null })),
    ...ctx.people.map((p): ContextUsed => ({ kind: 'person', id: p.id, label: p.name, detail: p.relationship })),
    ...ctx.tasks.map((c): ContextUsed => ({ kind: 'task', id: c.id, label: clip(oneLine(c.text), 90), detail: taskLabel(c, now) })),
    ...ctx.events.map((e): ContextUsed => ({ kind: 'event', id: e.id, label: clip(oneLine(e.title), 90), detail: eventLabel(e, now) })),
  ];
}
