// The text each person, task, and event is embedded from (decision 77). Saved items keep their
// own vectors (item_vectors, `embedText`); this covers the rest of what the user has saved.
import { createHash } from 'node:crypto';
import type { CalendarEvent } from '../calendar/types';
import type { CommitmentView, Interaction, Person, PersonAlias } from '../people/types';
import type { ContextKind, Store } from '../store/store';

export interface ContextDoc {
  /** The person's, task's, or event's own id. */
  id: string;
  kind: ContextKind;
  text: string;
}

/** About what the embedding model reads (all-MiniLM-L6-v2 stops at 256 tokens). */
const MAX_DOC_CHARS = 1000;
const MAX_NOTE_CHARS = 400;
const RECENT_MESSAGES = 3;
const MAX_MESSAGE_CHARS = 160;

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();

// Made once: toLocaleDateString builds a new formatter on every call, which was most of a sync's time.
let formats: { day: Intl.DateTimeFormat; time: Intl.DateTimeFormat } | null = null;

/** "Thursday, Oct 16" for a day, with "1:00 PM" added for a time. Local time, like the Calendar tab. */
export function dayWords(iso: string): string {
  const dateOnly = iso.length === 10;
  const d = new Date(dateOnly ? `${iso}T12:00:00` : iso);
  if (Number.isNaN(d.getTime())) return iso;
  formats ??= {
    day: new Intl.DateTimeFormat('en-US', { weekday: 'long', month: 'short', day: 'numeric' }),
    time: new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' }),
  };
  const day = formats.day.format(d);
  return dateOnly ? day : `${day}, ${formats.time.format(d)}`;
}

/**
 * A person: their names, relationship, note, and the last few messages. Emails and handles are
 * left out: meaning doesn't find them, exact matching does.
 */
export function personDoc(p: Pick<Person, 'id' | 'name' | 'note' | 'relationship' | 'aliases'>, recent: Pick<Interaction, 'direction' | 'text'>[]): ContextDoc {
  const others = p.aliases.filter((a) => a.kind === 'name' && a.value !== p.name).map((a) => a.value);
  const lines = [others.length ? `${p.name} (also ${others.join(', ')})` : p.name];
  if (p.relationship) lines.push(`Relationship: ${p.relationship}`);
  if (p.note?.trim()) lines.push(`Note: ${clip(oneLine(p.note), MAX_NOTE_CHARS)}`);
  for (const i of recent.slice(0, RECENT_MESSAGES)) {
    lines.push(`${i.direction === 'inbound' ? 'They wrote' : 'The user wrote'}: ${clip(oneLine(i.text), MAX_MESSAGE_CHARS)}`);
  }
  return { id: p.id, kind: 'person', text: clip(lines.join('\n'), MAX_DOC_CHARS) };
}

/** A task: what it is, who owes whom, and when it's due. Its status is left out, so ticking it off embeds nothing. */
export function taskDoc(c: Pick<CommitmentView, 'id' | 'owner' | 'text' | 'due_at' | 'person_name'>): ContextDoc {
  const lines = [`Task: ${oneLine(c.text)}`];
  if (c.person_name) lines.push(c.owner === 'me' ? `The user owes ${c.person_name}` : `${c.person_name} owes the user`);
  else lines.push(c.owner === 'me' ? "The user's own task" : 'Owed to the user');
  if (c.due_at) lines.push(`Due ${dayWords(c.due_at)}`);
  return { id: c.id, kind: 'task', text: clip(lines.join('\n'), MAX_DOC_CHARS) };
}

/** An event: title, when, where, and who comes. */
export function eventDoc(e: Pick<CalendarEvent, 'id' | 'title' | 'starts_at' | 'ends_at' | 'all_day' | 'location' | 'attendees'>): ContextDoc {
  const lines = [`Event: ${oneLine(e.title)}`];
  // The end's time alone when it ends the same day ("to 5:00 PM"), else its day too.
  const endWords = !e.all_day && e.ends_at ? dayWords(e.ends_at) : null;
  const sameDay = endWords !== null && endWords.startsWith(dayWords(e.starts_at.slice(0, 10)));
  const end = endWords ? ` to ${sameDay ? endWords.split(', ').pop() : endWords}` : '';
  lines.push(`${e.all_day ? 'All day ' : ''}${dayWords(e.starts_at)}${end}`);
  if (e.location?.trim()) lines.push(`At ${oneLine(e.location)}`);
  if (e.attendees.length) lines.push(`With ${e.attendees.join(', ')}`);
  return { id: e.id, kind: 'event', text: clip(lines.join('\n'), MAX_DOC_CHARS) };
}

/**
 * Every person, task (open or finished), and event, as the text to embed. Five queries in all
 * rather than the repos' per-row reads: a sync runs this whole on every change.
 */
export function contextDocs(store: Store): ContextDoc[] {
  const { db } = store;
  const aliases = new Map<string, PersonAlias[]>();
  for (const a of db.prepare("SELECT person_id, kind, value FROM person_aliases WHERE kind = 'name' ORDER BY value").all() as unknown as (PersonAlias & { person_id: string })[]) {
    let list = aliases.get(a.person_id);
    if (!list) aliases.set(a.person_id, (list = []));
    list.push({ kind: a.kind, value: a.value });
  }
  const recent = new Map<string, Pick<Interaction, 'direction' | 'text'>[]>();
  const messages = db
    .prepare(
      `SELECT person_id, direction, text FROM (
         SELECT person_id, direction, text, ROW_NUMBER() OVER (PARTITION BY person_id ORDER BY occurred_at DESC, rowid DESC) AS n FROM interactions
       ) WHERE n <= ? ORDER BY person_id, n`,
    )
    .all(RECENT_MESSAGES) as (Pick<Interaction, 'direction' | 'text'> & { person_id: string })[];
  for (const m of messages) {
    let list = recent.get(m.person_id);
    if (!list) recent.set(m.person_id, (list = []));
    list.push({ direction: m.direction, text: m.text });
  }

  const docs: ContextDoc[] = [];
  const people = db.prepare('SELECT id, name, note, relationship FROM people').all() as Pick<Person, 'id' | 'name' | 'note' | 'relationship'>[];
  for (const p of people) docs.push(personDoc({ ...p, aliases: aliases.get(p.id) ?? [] }, recent.get(p.id) ?? []));
  const tasks = db
    .prepare('SELECT c.id, c.owner, c.text, c.due_at, p.name AS person_name FROM commitments c LEFT JOIN people p ON p.id = c.person_id')
    .all() as Pick<CommitmentView, 'id' | 'owner' | 'text' | 'due_at' | 'person_name'>[];
  for (const c of tasks) docs.push(taskDoc(c));
  const events = db.prepare('SELECT id, title, starts_at, ends_at, all_day, location, attendees FROM calendar_events').all() as {
    id: string;
    title: string;
    starts_at: string;
    ends_at: string | null;
    all_day: number;
    location: string | null;
    attendees: string;
  }[];
  for (const e of events) docs.push(eventDoc({ ...e, all_day: e.all_day === 1, attendees: parseAttendees(e.attendees) }));
  return docs;
}

function parseAttendees(json: string): string[] {
  try {
    const parsed = JSON.parse(json) as unknown;
    return Array.isArray(parsed) ? parsed.filter((a): a is string => typeof a === 'string') : [];
  } catch {
    return [];
  }
}

/** What context_docs stores to tell whether a row's text changed since it was embedded. */
export function docHash(doc: ContextDoc): string {
  return createHash('sha256').update(doc.text).digest('hex').slice(0, 32);
}
