// Tasks, formerly "What did I promise" (spec: People layer; decision 36): one structured call
// finds the promises, requests, and todos in the selected message and says how each relates to
// the open tasks with the same people; code resolves the due phrases, and the user confirms.
// The result also lists every open task with the people involved, whatever the message says.
import { z } from 'zod';
import extractPrompt from '../../prompts/extract-commitments.md?raw';
import type { LlmProvider } from '../llm/types';
import { resolveDue } from '../people/dates';
import type { DetectedPerson } from '../people/detect';
import { canonicalize, describeIdentity } from '../people/names';
import { resolvePerson } from '../people/resolve';
import type { CommitmentView, NewPersonDetails, PromiseRow, PromiseSaveRow, TaskChange } from '../people/types';

export type { PromiseRow, PromiseSaveRow } from '../people/types';
import type { Settings } from '../settings';
import type { PeopleRepo } from '../store/people';
import { isoNow, type ContainerContext, type SelectionPayload } from '../types';
import { contextWindow } from './context';
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
        owner: z.enum(['me', 'them']).describe('me: the user has to do it. them: someone else has to.'),
        person_name: z.string().describe('The other person, as written, or "". Never the user.'),
        text: z.string().describe('The task, 3 to 12 words, starting with a verb, without the name or deadline.'),
        due_phrase: z.string().describe('The deadline exactly as written, or "".'),
        // Not bounded here, like Who: one row scored 85 would fail the whole call. Read as 0.85.
        confidence: z.number().describe('0 to 1.'),
        change: z.enum(['new', 'same', 'done', 'moved']).describe('new, or what the message does to the open task in open_task.'),
        open_task: z.enum(['none', ...openKeys] as [string, ...string[]]).describe('The key of the open task this row is about, or "none".'),
      }),
    ),
  });
}
export const ExtractedCommitmentsSchema = commitmentsSchema([]);

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
}

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
  const author = input.authorIsMe ? 'the user' : (input.author?.name ?? input.author?.email ?? 'unknown');
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
    `## Selected message (from ${selection.source_app})`,
    '<selection>',
    selection.text.slice(0, MAX_SELECTION),
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
    const dupe = `${c.owner}:${canonicalize(text)}`;
    if (seen.has(dupe)) continue;
    seen.add(dupe);
    const written = c.person_name.trim() || null;
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
      owner: c.owner,
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
    out = matchOpenTasks(rulesCommitments(input.selection.text.slice(0, MAX_SELECTION), author, now), open);
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
        maxOutputTokens: 900,
      },
      commitmentsSchema(open.map((o) => o.key)),
    );
    [out, found] = await Promise.all([call, detected]);
  }
  const rows = toPromiseRows(out, people, sourceApp, now, found, open);
  const everyone = new Set([...ids, ...exactIds(people, found, sourceApp), ...rows.flatMap((r) => (r.match?.kind === 'exact' ? [r.match.personId] : []))]);
  const about = new Set(rows.flatMap((r) => (r.existing ? [r.existing.id] : [])));
  const rest = people.commitments({ personIds: [...everyone], status: 'open' }).filter((t) => !about.has(t.id));
  return { rows, open: rest, byRules };
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
