// Tasks, formerly "What did I promise" (spec: People layer; decision 36): one structured call
// finds the promises, requests, and todos in the selected message and says how each relates to
// the open tasks with the same people; code resolves the due phrases, and the user confirms.
// The result also lists every open task with the people involved, whatever the message says.
import { z } from 'zod';
import extractPrompt from '../../prompts/extract-commitments.md?raw';
import type { LlmProvider } from '../llm/types';
import { resolveDue } from '../people/dates';
import { splitMessages, type ReadMessage } from '../people/conversation';
import type { DetectedPerson } from '../people/detect';
import { canonicalize, describeIdentity, isMe } from '../people/names';
import { resolvePerson } from '../people/resolve';
import type { CommitmentView, NewPersonDetails, PromiseRow, PromiseSaveRow, TaskChange } from '../people/types';

export type { PromiseRow, PromiseSaveRow } from '../people/types';
import type { Settings } from '../settings';
import type { PeopleRepo } from '../store/people';
import { isoNow, type ContainerContext, type SelectionPayload } from '../types';
import { ExtractedEventSchema, rulesEvents, toEventRows, type ExtractedEvent } from '../calendar/events';
import type { CalendarEvent, EventCandidate } from '../calendar/types';
import type { CalendarRepo } from '../store/calendar';
import { contextWindow } from './context';
import { describeSource } from '../people/reply-style';
import { matchOpenTasks, rulesCommitments } from './promise-rules';

/** An open task shown to the model under a short key ("t1"), so its answer can point at it. */
export interface OpenTaskRef {
  key: string;
  task: CommitmentView;
}

/** The answer's schema. `open_task` is an enum of the keys of the open tasks sent (decision 22). */
export function commitmentsSchema(openKeys: string[]) {
  return z.object({
    commitments: z.array(
      z.object({
        // Not 'me' and 'them': a message author's "I" read as `me` flipped owners (Step 21's Tasks eval).
        owner: z.enum(['user', 'other']).describe('user: the user has to do it. other: someone else has to.'),
        person_name: z.string().describe('The other person, as written, or "". Never the user.'),
        text: z.string().describe('The task, 3 to 12 words, starting with a verb, without the name or deadline.'),
        due_phrase: z.string().describe('The deadline exactly as written, or "".'),
        // Not bounded here, like Who: one row scored 85 would fail the whole call. Read as 0.85.
        confidence: z.number().describe('0 to 1.'),
        change: z.enum(['new', 'same', 'done', 'moved']).describe('new, or what the message does to the open task in open_task.'),
        open_task: z.enum(['none', ...openKeys] as [string, ...string[]]).describe('The key of the open task this row is about, or "none".'),
      }),
    ),
    // Step 19.2 (decision 37): events come from the same call.
    events: z.array(ExtractedEventSchema),
  });
}
export const ExtractedCommitmentsSchema = commitmentsSchema([]);
/** The model's answer as it comes back (owners as user/other), before code reads it. */
export type ModelCommitments = z.infer<typeof ExtractedCommitmentsSchema>;

/** A row as the model (or the patterns) found it. Pattern rows leave `change` and `open_task` out until matched. */
export interface ExtractedCommitment {
  owner: 'me' | 'them';
  person_name: string;
  text: string;
  due_phrase: string;
  confidence: number;
  change?: TaskChange;
  open_task?: string;
}
export interface ExtractedCommitments {
  commitments: ExtractedCommitment[];
  /** Missing in pattern output and older test answers. */
  events?: ExtractedEvent[];
}

/** The model's owner (user or other) as rows and storage keep it (me or them). */
const ownerOf = (o: string): 'me' | 'them' => (o === 'user' || o === 'me' ? 'me' : 'them');

/** At most this many open tasks go into the prompt. */
const MAX_OPEN = 12;

const MAX_ROWS = 8;
const MAX_SELECTION = 6000;
const CONTEXT_CHARS = 3000;
/** Rows at or above this confidence start selected. */
export const SELECT_CONFIDENCE = 0.5;
const SELECTION_MARK = '[SELECTION]';

export interface PromisesInput {
  selection: SelectionPayload;
  container?: ContainerContext | null;
  /** From detectPeople: who wrote the selected message. */
  author: DetectedPerson | null;
  authorIsMe: boolean;
  /** From detectPeople: everyone the message names, the author first. Their open tasks are checked. */
  people?: DetectedPerson[];
  /** Who wrote each message in the selection, from the conversation read (decision 48). */
  messages?: ReadMessage[] | null;
}

/**
 * The selection with each message's author in brackets ("[Jordan Hale] can you send…",
 * "[the user] sure, by Friday"), when the read found more than one writer; else null.
 */
export function markedSelection(text: string, messages: ReadMessage[] | null | undefined): string | null {
  if (!messages || messages.length < 2) return null;
  const who = (m: { author: string | null; user: boolean }) => (m.user ? 'the user' : (m.author ?? 'unknown'));
  if (new Set(messages.map(who)).size < 2) return null;
  return splitMessages(text, messages)
    .map((m) => `[${who(m)}] ${m.text}`)
    .join('\n');
}

function describeTask(t: CommitmentView): string {
  const who = t.person_name ?? 'no one';
  const owes = t.owner === 'me' ? (t.person_name ? `The user owes ${who}` : 'The user (a personal todo)') : `${who} owes the user`;
  return `${owes}: ${t.text}${t.due_at ? ` (due ${t.due_at.slice(0, 10)})` : ''}`;
}

export function buildPromisesPrompt(settings: Pick<Settings, 'identity'>, input: PromisesInput, now: Date, open: OpenTaskRef[] = []): string {
  const { selection } = input;
  const win = contextWindow(selection, input.container, CONTEXT_CHARS);
  const surrounding = win.text.slice(0, win.selection_start) + SELECTION_MARK + win.text.slice(win.selection_start + win.selection_length);
  const marked = markedSelection(selection.text, input.messages);
  const author = marked
    ? 'Several people: each message in the selection starts with its author in brackets. The user wrote the ones marked [the user].'
    : input.authorIsMe
      ? 'the user'
      : (input.author?.name ?? input.author?.email ?? 'unknown');
  const day = now.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  const parts = [
    '## The user',
    describeIdentity(settings.identity) ?? 'Unknown (the person reading this message).',
    '',
    '## Message author',
    author,
    '',
    '## Today',
    `${day} (for context only; return due phrases as written)`,
    '',
    `## Selected message (from ${describeSource(selection.source_app, selection.window_title)})`,
    '<selection>',
    (marked ?? selection.text).slice(0, MAX_SELECTION),
    '</selection>',
  ];
  if (surrounding.trim() !== SELECTION_MARK) parts.push('', `## Context (${SELECTION_MARK} marks the selection)`, '<context>', surrounding, '</context>');
  parts.push('', '## Open tasks with these people', ...(open.length ? open.map((o) => `${o.key}: ${describeTask(o.task)}`) : ['None.']));
  return parts.join('\n');
}

const tokens = (s: string) => canonicalize(s).split(' ').filter(Boolean);

/**
 * The person the people reader found for a name in a commitment: the same name, or a lone first
 * name ("Maya") that only one of them has ("Maya Chen"), or their email. Null when it's unclear.
 */
export function findDetected(name: string, detected: DetectedPerson[]): DetectedPerson | null {
  const key = canonicalize(name);
  if (!key) return null;
  const same = detected.find((d) => (d.name && canonicalize(d.name) === key) || (d.email && d.email.toLowerCase() === name.trim().toLowerCase()));
  if (same) return same;
  const parts = tokens(name);
  if (parts.length !== 1) return null;
  const firsts = detected.filter((d) => d.name && tokens(d.name).length > 1 && tokens(d.name)[0] === parts[0]);
  return firsts.length === 1 ? firsts[0]! : null;
}

export function detailsOf(d: DetectedPerson): NewPersonDetails {
  const note = [d.detail, d.about].filter((s): s is string => Boolean(s?.trim())).join('. ');
  return { email: d.email, handle: d.handle, note: note || null, relationship: d.relationship ?? null };
}

/** Words too common to tie a row to the selection. */
const COMMON = new Set(['the', 'and', 'for', 'with', 'from', 'that', 'this', 'your', 'you', 'our', 'they', 'them', 'will', 'can', 'could', 'would', 'should', 'have', 'has', 'about', 'into', 'some', 'any', 'all', 'please']);
/** A word's first 4 letters, so "sending" meets "send" and "screenshots" meets "screenshot". */
const stems = (s: string) => new Set(tokens(s).filter((w) => w.length >= 3 && !COMMON.has(w)).map((w) => w.slice(0, 4)));

/**
 * Whether the selected text backs a row the model found: one of its words, or its date phrase as
 * written. The prompt asks for tasks in the selection only, but a small model also lifts them from
 * the surrounding lines (Step 21: a Notepad line got tasks from the lines below it).
 */
export function inSelection(selection: string, text: string, phrase = ''): boolean {
  const sel = stems(selection);
  if ([...stems(text)].some((w) => sel.has(w))) return true;
  const p = canonicalize(phrase);
  return p.length > 0 && canonicalize(selection).includes(p);
}

/** A promise ("I'll send…") or a request ("can you send…") in someone else's message, by the verb that follows. */
const PROMISE = /\b(?:i'll|i will|i'm going to|im going to|i can|let me)\s+(?:also\s+|just\s+)?([a-z]+)/gi;
const REQUEST = /\b(?:can|could|would|will) you\s+(?:also\s+|please\s+)?([a-z]+)|\bplease\s+([a-z]+)/gi;

/**
 * Who owes a task, read from someone else's message: "them" when its writer promised the task's
 * verb ("I'll get you the draft"), "me" when they asked the user for it ("can you send…"), else
 * null. Step 21's Tasks eval: the model kept reading another writer's "I'll" as the user's.
 */
export function ownerFromText(selection: string, taskText: string): 'me' | 'them' | null {
  const verb = taskText.trim().toLowerCase().split(/\s+/)[0]?.slice(0, 4);
  if (!verb || verb.length < 3) return null;
  const hits = (re: RegExp) => [...selection.matchAll(re)].some((m) => (m[1] ?? m[2] ?? '').toLowerCase().slice(0, 4) === verb);
  const promised = hits(PROMISE);
  const asked = hits(REQUEST);
  return promised === asked ? null : promised ? 'them' : 'me';
}

/** What code checks the rows against: the selected text, the user, and the author (decision 22). */
export interface RowCheck {
  selection: string;
  me: Settings['identity'];
  /** The selected message's author when it isn't the user. */
  author: string | null;
  /** The one other person in the selection (its author, or the only other writer), else null. A task left without a person is between the user and them. */
  counterpart: string | null;
}

/**
 * Turns the model's answer into review rows: due phrases resolved in code, names resolved
 * against people. `detected` is what the people reader (Who's) found in the same text: a short
 * name grows to the full one it found, and someone not saved yet gets their details.
 */
export function toPromiseRows(
  out: ExtractedCommitments,
  people: PeopleRepo,
  sourceApp: string,
  now: Date,
  detected: DetectedPerson[] = [],
  open: OpenTaskRef[] = [],
  check?: RowCheck,
): PromiseRow[] {
  const seen = new Set<string>();
  const touched = new Set<string>();
  const rows: PromiseRow[] = [];
  for (const [i, c] of out.commitments.entries()) {
    const text = c.text.replace(/\s+/g, ' ').trim();
    if (!text || rows.length >= MAX_ROWS) continue;
    // A row about an open task: the task keeps its owner, person, and text; only what changes is offered.
    const existing = c.change && c.change !== 'new' ? (open.find((o) => o.key === c.open_task)?.task ?? null) : null;
    if (existing) {
      if (touched.has(existing.id)) continue;
      touched.add(existing.id);
      const due_phrase = c.due_phrase.trim() || null;
      const due_at = resolveDue(due_phrase, now);
      // A move needs a new date code can read; without one it is only a mention.
      const change: TaskChange = c.change === 'moved' && (!due_at || due_at === existing.due_at) ? 'same' : c.change!;
      const confidence = Math.min(1, Math.max(0, c.confidence > 1 ? c.confidence / 100 : c.confidence));
      rows.push({
        key: `c${i}`,
        change,
        existing,
        owner: existing.owner,
        text: existing.text,
        due_phrase: change === 'moved' ? due_phrase : null,
        due_at: change === 'moved' ? due_at : existing.due_at,
        confidence,
        selected: change !== 'same' && confidence >= SELECT_CONFIDENCE,
        person_name: existing.person_name,
        match: existing.person_id && existing.person_name ? { personId: existing.person_id, name: existing.person_name, kind: 'exact' } : null,
        details: null,
      });
      continue;
    }
    // A new task must come from the selected text, not its surroundings.
    if (check && !inSelection(check.selection, text, c.due_phrase)) continue;
    let owner = c.owner;
    let written = c.person_name.trim() || null;
    // The user is never the other person: "they owe the user" with the user named is the user's task, owed to the author.
    if (check && written && isMe(written, check.me)) {
      owner = 'me';
      written = check.author;
    }
    // No person, but only one other person in the selection: the task is between the user and them (Step 21's Tasks eval).
    if (check && !written) written = check.counterpart;
    // A single other writer's own words decide who owes it, over the model's reading.
    if (check?.author && check.counterpart === check.author) {
      const said = ownerFromText(check.selection, text);
      if (said) owner = said;
    }
    const dupe = `${owner}:${canonicalize(text)}`;
    if (seen.has(dupe)) continue;
    seen.add(dupe);
    const found = written ? findDetected(written, detected) : null;
    const name = found?.name && tokens(found.name).length > tokens(written!).length ? found.name : written;
    const due_phrase = c.due_phrase.trim() || null;
    let match: PromiseRow['match'] = null;
    if (name) {
      const r = resolvePerson(people, { name }, sourceApp);
      if (r.kind !== 'none') {
        const p = people.get(r.personId);
        if (p) match = { personId: p.id, name: p.name, kind: r.kind };
      }
    }
    // A score out of 100 reads as a share; anything else is clamped to 0 to 1.
    const confidence = Math.min(1, Math.max(0, c.confidence > 1 ? c.confidence / 100 : c.confidence));
    rows.push({
      key: `c${i}`,
      change: 'new',
      existing: null,
      owner,
      text: text.slice(0, 300),
      due_phrase,
      due_at: resolveDue(due_phrase, now),
      confidence,
      selected: confidence >= SELECT_CONFIDENCE,
      person_name: name,
      match,
      details: found && match?.kind !== 'exact' ? detailsOf(found) : null,
    });
  }
  return rows;
}

/** Why the rows came from patterns instead of a model: Local only with no local model, or no Fast model. */
export type PromisesByRules = null | 'local_only' | 'no_model';

export interface PromisesExtract {
  rows: PromiseRow[];
  /** Events the message describes (decision 37). */
  events: EventCandidate[];
  /** Saved events on the days of those events, to spot a clash or a duplicate. */
  sameDay: CalendarEvent[];
  /** Open tasks with the people involved that no row is about (decision 36). */
  open: CommitmentView[];
  byRules: PromisesByRules;
}

/** Saved people that names resolve to exactly (fuzzy matches are only suggestions, decision 20). */
function exactIds(people: PeopleRepo, found: (Pick<DetectedPerson, 'name' | 'email' | 'handle'> | null | undefined)[], sourceApp: string): string[] {
  const ids = new Set<string>();
  for (const p of found) {
    if (!p || !(p.name || p.email || p.handle)) continue;
    const r = resolvePerson(people, { name: p.name ?? null, email: p.email, handle: p.handle }, sourceApp);
    if (r.kind === 'exact') ids.add(r.personId);
  }
  return [...ids];
}

/**
 * One structured call on the Fast role (action "promises"). With no usable model (Local only
 * without a local model, or no key) sentence patterns find them instead (`rulesCommitments`),
 * matched to open tasks by their words. `detected` is the people reader's answer for the same
 * text, which runs alongside. `open` is every other open task with the people involved: the
 * author, anyone named, and the people the rows resolved to.
 */
export async function extractPromises(
  llm: LlmProvider,
  people: PeopleRepo,
  settings: Pick<Settings, 'identity' | 'privacy'>,
  input: PromisesInput,
  signal?: AbortSignal,
  now: Date = new Date(),
  detected: Promise<DetectedPerson[]> | DetectedPerson[] = [],
  calendar?: CalendarRepo,
): Promise<PromisesExtract> {
  const sourceApp = input.selection.source_app;
  const ids = exactIds(people, [input.author, ...(input.people ?? [])], sourceApp);
  const open: OpenTaskRef[] = people
    .commitments({ personIds: ids, status: 'open' })
    .slice(0, MAX_OPEN)
    .map((task, i) => ({ key: `t${i + 1}`, task }));

  let out: ExtractedCommitments;
  let found: DetectedPerson[];
  let byRules: PromisesByRules = null;
  if (!llm.hasModel('fast')) {
    const author = { name: input.authorIsMe ? null : (input.author?.name ?? null), isMe: input.authorIsMe };
    const text = input.selection.text.slice(0, MAX_SELECTION);
    out = { ...matchOpenTasks(rulesCommitments(text, author, now), open), events: rulesEvents(text, author) };
    found = await detected;
    byRules = settings.privacy === 'local' ? 'local_only' : 'no_model';
  } else {
    const call = llm.structured(
      {
        role: 'fast',
        action: 'promises',
        instructions: extractPrompt,
        prompt: buildPromisesPrompt(settings, input, now, open),
        signal,
        temperature: 0,
        maxOutputTokens: 1200,
      },
      commitmentsSchema(open.map((o) => o.key)),
    );
    const [answer, people_] = await Promise.all([call, detected]);
    // The model answers user/other; rows and storage keep me/them.
    out = { ...answer, commitments: answer.commitments.map((c) => ({ ...c, owner: ownerOf(c.owner) })) };
    found = people_;
  }
  // Pattern rows come from the selection itself; the model's are checked against it.
  const author = input.authorIsMe ? null : (input.author?.name ?? null);
  const writers = [...new Set((input.messages ?? []).flatMap((m) => (m.author && !m.user ? [m.author] : [])))];
  const check: RowCheck | undefined = byRules
    ? undefined
    : { selection: input.selection.text, me: settings.identity, author, counterpart: writers.length ? (writers.length === 1 ? writers[0]! : null) : author };
  const rows = toPromiseRows(out, people, sourceApp, now, found, open, check);
  const everyone = new Set([...ids, ...exactIds(people, found, sourceApp), ...rows.flatMap((r) => (r.match?.kind === 'exact' ? [r.match.personId] : []))]);
  const about = new Set(rows.flatMap((r) => (r.existing ? [r.existing.id] : [])));
  const rest = people.commitments({ personIds: [...everyone], status: 'open' }).filter((t) => !about.has(t.id));
  const events = toEventRows(check ? (out.events ?? []).filter((e) => inSelection(check.selection, e.title, e.when)) : (out.events ?? []), people, sourceApp, now);
  const days = [...new Set(events.flatMap((e) => (e.starts_at ? [e.starts_at.slice(0, 10)] : [])))];
  const sameDay = calendar ? days.flatMap((d) => calendar.list({ from: d, to: d })) : [];
  return { rows, events, sameDay, open: rest, byRules };
}

export interface PromiseSaveContext {
  /** The selected message, stored as an interaction with the people it involves. */
  message: string;
  sourceApp: string;
  /** The author's person id when they resolved exactly, so the message counts as theirs. */
  authorPersonId: string | null;
  authorIsMe: boolean;
}

/**
 * Saves the reviewed commitments. New people are created (once per name). The message is
 * stored as an interaction: inbound with its author when the author is among the people saved,
 * or outbound with each person when the user wrote it.
 */
export function savePromises(people: PeopleRepo, rows: PromiseSaveRow[], ctx: PromiseSaveContext): { saved: number; created: number; updated: number } {
  let created = 0;
  const newIds = new Map<string, string>();
  const personFor = (row: PromiseSaveRow): string | null => {
    if (!row.person) return null;
    if (row.person.kind === 'existing') return people.get(row.person.id) ? row.person.id : null;
    const key = canonicalize(row.person.name);
    if (!key) return null;
    const known = newIds.get(key) ?? people.byName(row.person.name);
    if (known) return known;
    const { email, handle, note, relationship } = row.person;
    const aliases = [...(email ? [{ kind: 'email' as const, value: email }] : []), ...(handle ? [{ kind: 'handle' as const, value: handle }] : [])];
    const p = people.create({ name: row.person.name, note: note ?? null, relationship: relationship ?? null, aliases });
    created++;
    newIds.set(key, p.id);
    return p.id;
  };

  const interactions = new Map<string, string>();
  const interactionFor = (personId: string): string | null => {
    const existing = interactions.get(personId);
    if (existing) return existing;
    let direction: 'inbound' | 'outbound' | null = null;
    if (ctx.authorIsMe) direction = 'outbound';
    else if (ctx.authorPersonId === personId) direction = 'inbound';
    if (!direction || !ctx.message.trim()) return null;
    const i = people.addInteraction({ person_id: personId, direction, text: ctx.message, source_app: ctx.sourceApp });
    interactions.set(personId, i.id);
    return i.id;
  };

  let saved = 0;
  let updated = 0;
  for (const row of rows) {
    // A row about an open task finishes it or moves its date; "same" has nothing to save.
    if (row.change && row.change !== 'new') {
      const task = row.existingId ? people.getCommitment(row.existingId) : null;
      if (!task || task.status !== 'open' || row.change === 'same') continue;
      if (row.change === 'done') people.setCommitmentStatus(task.id, 'done');
      else people.updateCommitment(task.id, { due_at: row.due_at });
      if (task.person_id) interactionFor(task.person_id);
      updated++;
      continue;
    }
    if (!row.text.trim()) continue;
    const personId = personFor(row);
    people.addCommitment({
      person_id: personId,
      owner: row.owner,
      text: row.text,
      due_at: row.due_at,
      source_interaction_id: personId ? interactionFor(personId) : null,
    });
    saved++;
  }
  return { saved, created, updated };
}

// ---- due-date reminders ----

/**
 * The latest due date ("YYYY-MM-DD") whose reminder may show now: today from the reminder hour
 * on, else yesterday (so a reminder missed while the app was closed still shows at launch).
 */
export function reminderCutoff(now: Date, hour: number): string {
  if (now.getHours() >= hour) return isoNow(now).slice(0, 10);
  return isoNow(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 12)).slice(0, 10);
}

/** The notification's title and body. Shown only on this computer. */
/** "Lunch with Jordan" / "Starts at 1:00 PM at Northwind" for an event's reminder. */
export function eventReminderText(e: CalendarEvent): { title: string; body: string } {
  const when = e.all_day
    ? 'Today'
    : `Starts at ${new Date(e.starts_at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`;
  return { title: e.title, body: `${when}${e.location ? ` at ${e.location}` : ''}` };
}

export function reminderText(c: CommitmentView, now: Date): { title: string; body: string } {
  const today = isoNow(now).slice(0, 10);
  const day = c.due_at?.slice(0, 10) ?? today;
  const when =
    day === today
      ? 'Due today'
      : `Overdue since ${new Date(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10))).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;
  const title = c.owner === 'me' ? (c.person_name ? `You promised ${c.person_name}` : 'You have something due') : `${c.person_name ?? 'Someone'} promised you`;
  return { title, body: `${c.text}
${when}` };
}
