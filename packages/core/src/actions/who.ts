// "Who is this": one Fast structured call when Who opens, then code keeps or drops each row.
// Local only and no key stay on the strict text pass. People are never created here.
import { z } from 'zod';
import whoPrompt from '../../prompts/who.md?raw';
import type { LlmProvider } from '../llm/types';
import { type DetectedPerson, type DetectInput, type Detection } from '../people/detect';
import { describeIdentity } from '../people/names';
import { RELATIONSHIPS } from '../people/relationship';
import { acceptWhoRows, localWho, whoCorpus } from '../people/who-judge';
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
      name: z.string(),
      email: z.string(),
      handle: z.string(),
      role: z.string(),
      about: z.string(),
      relationship: z.enum(RELATIONSHIPS),
      // Not bounded here: one row scored 85 would fail the whole call. acceptWhoRows reads it.
      confidence: z.number(),
      evidence: z.string(),
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

const WHO_CORPUS_CHARS = 8000;

export function buildWhoPrompt(identity: Identity, input: DetectInput): string {
  return [
    '## The user',
    describeIdentity(identity) ?? 'Unknown. Do not guess who the user is.',
    '',
    `## Captured text (from ${input.source_app})`,
    input.window_title ? `Window: ${input.window_title}` : '',
    '<text>',
    whoCorpus(input).slice(0, WHO_CORPUS_CHARS),
    '</text>',
  ]
    .filter((line) => line !== '')
    .join('\n');
}

/** Who the text names, before matching to saved people. The shell caches it per input. */
export interface WhoRead {
  people: DetectedPerson[];
  local: WhoLocal;
}

/**
 * Who opened. One Fast call (action "who") when a model is available; code then accepts the
 * rows. Local only, or no Fast model, reads the text only and leaves the note blank. Matching
 * to saved people is `buildWho`, done fresh each time so a person added since shows up.
 */
export async function readWho(
  llm: LlmProvider,
  settings: Pick<Settings, 'identity' | 'localOnly'>,
  input: DetectInput,
  signal?: AbortSignal,
  onModelError?: (e: unknown) => void,
): Promise<WhoRead> {
  const local: WhoLocal = settings.localOnly ? 'local_only' : llm.hasModel('fast') ? null : 'no_model';
  if (local !== null) return { people: localWho(input, settings.identity), local };
  let rows: z.infer<typeof WhoPeopleSchema>['people'];
  try {
    const out = await llm.structured(
      {
        role: 'fast',
        action: 'who',
        instructions: whoPrompt,
        prompt: buildWhoPrompt(settings.identity, input),
        signal,
        temperature: 0,
        maxOutputTokens: 1000,
      },
      WhoPeopleSchema,
    );
    rows = out.people;
  } catch (e) {
    // A rate limit or a bad answer still leaves the people the text itself names.
    if (signal?.aborted) throw e;
    onModelError?.(e);
    return { people: localWho(input, settings.identity), local: 'model_failed' };
  }
  return { people: acceptWhoRows(rows, whoCorpus(input), settings.identity), local: null };
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
