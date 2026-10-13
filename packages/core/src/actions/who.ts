// "Who is this": one Fast structured call when Who opens, then code keeps or drops each row.
// Local only and no key stay on the strict text pass. People are never created here.
import { z } from 'zod';
import whoPrompt from '../../prompts/who.md?raw';
import type { LlmProvider } from '../llm/types';
import { type DetectedPerson, type DetectInput, type Detection } from '../people/detect';
import { describeIdentity } from '../people/names';
import { describeSource } from '../people/reply-style';
import { RELATIONSHIPS } from '../people/relationship';
import { acceptWhoRows, localWho, whoCorpus } from '../people/who-judge';
import { acceptMessages, authorFirst, readAuthor, type ReadMessage } from '../people/conversation';
import { resolvePerson } from '../people/resolve';
import type { PersonCard } from '../people/types';
import type { Identity, Settings } from '../settings';
import type { PeopleRepo } from '../store/people';
import type { ContainerContext, SelectionPayload } from '../types';

export interface WhoEntry {
  /** Stable within one view, for React keys. */
  key: string;
  detected: DetectedPerson;
  /** exact: their card. fuzzy: a possible match the user must confirm. none: offer Create person. */
  match: 'exact' | 'fuzzy' | 'none';
  score: number | null;
  person: PersonCard | null;
}

/** Why the list came from the text only: Local only, no Fast model, or the model call failed. */
export type WhoLocal = null | 'local_only' | 'no_model' | 'model_failed';

export interface WhoView {
  entries: WhoEntry[];
  /** False until the user entered their name, so "me" can't be told apart yet. */
  identitySet: boolean;
  /** Set when the list was read from the text only, with no model-written note. */
  local: WhoLocal;
}

export const WhoPeopleSchema = z.object({
  people: z.array(
    z.object({
      name: z.string().describe('Full name as written, or "" when only an email or handle identifies them.'),
      email: z.string().describe('Their own address as written, up to the end of the domain, or "".'),
      handle: z.string().describe('Their @handle without the @, or "".'),
      role: z.string().describe('A few words, such as "recruiter at Northwind", or "".'),
      about: z.string().describe('One line about them from the text, or "". Not the relationship.'),
      relationship: z.enum(RELATIONSHIPS).describe('How the user most likely knows them; other when unclear.'),
      // Not bounded here: one row scored 85 would fail the whole call. acceptWhoRows reads it.
      confidence: z.number().describe('0 to 1.'),
      evidence: z.string().describe('A short quote copied exactly from the text.'),
    }),
  ),
});

export interface PersonBadge {
  kind: 'person';
  personId: string;
  label: string;
}

const BEFORE_CHARS = 3000;
const AFTER_CHARS = 1000;

/** Text around the selection for detection: tier 2 when it was read, else tier 1. */
export function detectInputFor(selection: SelectionPayload, container?: ContainerContext | null): DetectInput {
  const base = { text: selection.text, source_app: selection.source_app, window_title: selection.window_title };
  if (container?.source === 'container' && container.text) {
    const start = Math.max(0, container.selection_start);
    const end = start + Math.max(0, container.selection_length);
    return { ...base, before: container.text.slice(Math.max(0, start - BEFORE_CHARS), start), after: container.text.slice(end, end + AFTER_CHARS) };
  }
  return { ...base, before: selection.context_before, after: selection.context_after };
}

export function buildWho(repo: PeopleRepo, detection: Detection, sourceApp: string, identitySet: boolean, local: WhoLocal = null): WhoView {
  const entries: WhoEntry[] = [];
  const seen = new Set<string>();
  detection.people.forEach((d, i) => {
    const r = resolvePerson(repo, d, sourceApp);
    if (r.kind !== 'none') {
      if (seen.has(r.personId)) return;
      seen.add(r.personId);
    }
    const person = r.kind === 'none' ? null : repo.card(r.personId);
    entries.push({ key: `${i}:${d.email ?? d.handle ?? d.name}`, detected: d, match: person ? r.kind : 'none', score: r.kind === 'fuzzy' ? r.score : null, person });
  });
  return { entries, identitySet, local };
}

/** The read sees the selection and a little around it, not the whole thread (decision 48: fewer input tokens). */
export const READ_BEFORE_CHARS = 1200;
export const READ_AFTER_CHARS = 300;
const READ_SELECTION_CHARS = 4000;
/** Messages (about 15 tokens each, at most 8) plus a few people rows. A cut-off answer is retried, which costs more. */
const READ_MAX_OUTPUT = 400;

/** The model reads who wrote each message in the selection and who the text names (decision 48). */
export const WhoReadSchema = z.object({
  messages: z.array(
    z.object({
      author: z.string().describe('Who wrote it, exactly as their name appears in the text.'),
      user: z.boolean().describe('True when the user wrote it.'),
      starts: z.string().describe("The message's first 5 words, copied exactly from the selection."),
    }),
  ),
  people: WhoPeopleSchema.shape.people,
});

/** Cuts `s` to its last `n` characters, starting at a line where it can. */
function lastLines(s: string, n: number): string {
  if (s.length <= n) return s;
  const cut = s.slice(-n);
  const nl = cut.indexOf('\n');
  return nl >= 0 && nl < cut.length - 1 ? cut.slice(nl + 1) : cut;
}

/** Cuts `s` to its first `n` characters, ending at a line where it can. */
function firstLines(s: string, n: number): string {
  if (s.length <= n) return s;
  const cut = s.slice(0, n);
  const nl = cut.lastIndexOf('\n');
  return nl > 0 ? cut.slice(0, nl) : cut;
}

/** What the read sees: the selection with about 1,200 characters before it and 300 after. */
export function readInput(input: DetectInput): DetectInput {
  return { ...input, text: input.text.slice(0, READ_SELECTION_CHARS), before: lastLines(input.before, READ_BEFORE_CHARS), after: firstLines(input.after, READ_AFTER_CHARS) };
}

/**
 * The read's prompt. It is also the cache key, so Who, Tasks, and Reply on one selection share
 * one call: build it from `detectInputFor` with the same container every time.
 */
export function buildWhoPrompt(identity: Identity, raw: DetectInput): string {
  const input = readInput(raw);
  const parts = ['## The user', describeIdentity(identity) ?? 'Unknown. Do not guess who the user is.', '', `## App: ${describeSource(input.source_app, input.window_title)}`];
  if (input.before.trim()) parts.push('', '<before>', input.before.trimEnd(), '</before>');
  parts.push('', '<selection>', input.text, '</selection>');
  if (input.after.trim()) parts.push('', '<after>', input.after.trimStart(), '</after>');
  return parts.join('\n');
}

/** Who the text names, before matching to saved people, and who wrote what. The shell caches it per input. */
export interface WhoRead {
  people: DetectedPerson[];
  /** The selection's messages from the model, accepted by code; null means use the local parser. */
  messages: ReadMessage[] | null;
  local: WhoLocal;
}

/**
 * The conversation read (decision 48), shared by Who is this, Tasks, and Reply: one Fast call
 * (action "who") when a model is available; code then accepts the people and the messages.
 * Local only without a local model, or no Fast model, reads the text only (`messages` null) and
 * leaves the note blank. Matching to saved people is `buildWho`, done fresh each time so a person
 * added since shows up.
 */
export async function readWho(
  llm: LlmProvider,
  settings: Pick<Settings, 'identity' | 'privacy'>,
  raw: DetectInput,
  signal?: AbortSignal,
  onModelError?: (e: unknown) => void,
): Promise<WhoRead> {
  const input = readInput(raw);
  const local: WhoLocal = llm.hasModel('fast') ? null : settings.privacy === 'local' ? 'local_only' : 'no_model';
  if (local !== null) return { people: localWho(input, settings.identity), messages: null, local };
  let out: z.infer<typeof WhoReadSchema>;
  try {
    out = await llm.structured(
      {
        role: 'fast',
        action: 'who',
        instructions: whoPrompt,
        prompt: buildWhoPrompt(settings.identity, input),
        signal,
        temperature: 0,
        maxOutputTokens: READ_MAX_OUTPUT,
      },
      WhoReadSchema,
    );
  } catch (e) {
    // A rate limit or a bad answer still leaves the people the text itself names.
    if (signal?.aborted) throw e;
    onModelError?.(e);
    return { people: localWho(input, settings.identity), messages: null, local: 'model_failed' };
  }
  const messages = acceptMessages(out.messages, input, settings.identity);
  const speakers = (messages ?? []).flatMap((m) => (m.author && !m.user ? [m.author] : []));
  const people = acceptWhoRows(out.people, whoCorpus(input), settings.identity, speakers);
  const by = readAuthor(messages, people);
  return { people: authorFirst(people, by?.author ?? null), messages, local: null };
}

/**
 * Who wrote the selected message, from the read when it has an author, else the local parser's
 * `detectPeople` (decision 47). Tasks and Reply use this so both name the same person.
 */
export function authorFrom(read: WhoRead | null, det: Detection): { author: DetectedPerson | null; authorIsMe: boolean } {
  const by = read ? readAuthor(read.messages, read.people) : null;
  return by ?? { author: det.author, authorIsMe: det.authorIsMe };
}

/**
 * Person badges for the bar (a known person matched, with open commitments or a note).
 * Exact matches only. The bar shows one chip ("Jordan +2 others"), so this can return
 * more than will fit on a row; the overlay collapses them.
 */
export function personBadges(repo: PeopleRepo, detection: Detection, sourceApp: string): PersonBadge[] {
  const out: PersonBadge[] = [];
  for (const d of detection.people) {
    if (out.length >= 8) break;
    const r = resolvePerson(repo, d, sourceApp);
    if (r.kind !== 'exact' || out.some((b) => b.personId === r.personId)) continue;
    const card = repo.card(r.personId, { interactions: 0, items: 0 });
    if (!card) continue;
    const open = card.youOwe.length + card.theyOwe.length;
    if (open === 0 && !card.note) continue;
    out.push({ kind: 'person', personId: card.id, label: open ? `${card.name} · ${open} open` : card.name });
  }
  return out;
}
