// "What did I promise" (spec: People layer): one structured call finds the commitments in the
// selected message, code resolves the due phrases, and the user picks which to save.
import { z } from 'zod';
import extractPrompt from '../../prompts/extract-commitments.md?raw';
import type { LlmProvider } from '../llm/types';
import { resolveDue } from '../people/dates';
import type { DetectedPerson } from '../people/detect';
import { canonicalize, describeIdentity } from '../people/names';
import { resolvePerson } from '../people/resolve';
import type { CommitmentView, NewPersonDetails, PromiseRow, PromiseSaveRow } from '../people/types';

export type { PromiseRow, PromiseSaveRow } from '../people/types';
import type { Settings } from '../settings';
import type { PeopleRepo } from '../store/people';
import { isoNow, type ContainerContext, type SelectionPayload } from '../types';
import { contextWindow } from './context';

export const ExtractedCommitmentsSchema = z.object({
  commitments: z.array(
    z.object({
      owner: z.enum(['me', 'them']).describe('me: the user has to do it. them: someone else has to.'),
      person_name: z.string().describe('The other person, as written, or "". Never the user.'),
      text: z.string().describe('The task, 3 to 12 words, starting with a verb, without the name or deadline.'),
      due_phrase: z.string().describe('The deadline exactly as written, or "".'),
      // Not bounded here, like Who: one row scored 85 would fail the whole call. Read as 0.85.
      confidence: z.number().describe('0 to 1.'),
    }),
  ),
});
export type ExtractedCommitments = z.infer<typeof ExtractedCommitmentsSchema>;

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
}

export function buildPromisesPrompt(settings: Pick<Settings, 'identity'>, input: PromisesInput, now: Date): string {
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
export function toPromiseRows(out: ExtractedCommitments, people: PeopleRepo, sourceApp: string, now: Date, detected: DetectedPerson[] = []): PromiseRow[] {
  const seen = new Set<string>();
  const rows: PromiseRow[] = [];
  for (const [i, c] of out.commitments.entries()) {
    const text = c.text.replace(/\s+/g, ' ').trim();
    if (!text || rows.length >= MAX_ROWS) continue;
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

/**
 * One structured call on the Fast role (action "promises"). Local only refuses inside the LLM
 * layer. `detected` is the people reader's answer for the same text, which runs alongside.
 */
export async function extractPromises(
  llm: LlmProvider,
  people: PeopleRepo,
  settings: Pick<Settings, 'identity'>,
  input: PromisesInput,
  signal?: AbortSignal,
  now: Date = new Date(),
  detected: Promise<DetectedPerson[]> | DetectedPerson[] = [],
): Promise<PromiseRow[]> {
  const call = llm.structured(
    {
      role: 'fast',
      action: 'promises',
      instructions: extractPrompt,
      prompt: buildPromisesPrompt(settings, input, now),
      signal,
      temperature: 0,
      maxOutputTokens: 700,
    },
    ExtractedCommitmentsSchema,
  );
  const [out, found] = await Promise.all([call, detected]);
  return toPromiseRows(out, people, input.selection.source_app, now, found);
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
export function savePromises(people: PeopleRepo, rows: PromiseSaveRow[], ctx: PromiseSaveContext): { saved: number; created: number } {
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
  for (const row of rows) {
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
  return { saved, created };
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
