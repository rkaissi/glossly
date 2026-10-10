// "Who is this": the people in a selection, each resolved against the people layer. Local
// only; no model call.
import { detectPeople, type DetectedPerson, type DetectInput, type Detection } from '../people/detect';
import { resolvePerson } from '../people/resolve';
import type { PersonCard } from '../people/types';
import type { KnownPerson } from '../router/types';
import type { Identity } from '../settings';
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

export interface WhoView {
  entries: WhoEntry[];
  /** False until the user entered their name, so "me" can't be told apart yet. */
  identitySet: boolean;
}

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

export function buildWho(repo: PeopleRepo, detection: Detection, sourceApp: string, identitySet: boolean): WhoView {
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
  return { entries, identitySet };
}

export function whoFor(
  repo: PeopleRepo,
  selection: SelectionPayload,
  container: ContainerContext | null | undefined,
  identity: Identity,
  known: KnownPerson[],
): WhoView {
  const detection = detectPeople(detectInputFor(selection, container), identity, known);
  return buildWho(repo, detection, selection.source_app, identity.name.trim().length > 0);
}

/**
 * Person badges for the bar (spec: a known person matched and has open commitments or a
 * note). Exact matches only; at most two.
 */
export function personBadges(repo: PeopleRepo, detection: Detection, sourceApp: string): PersonBadge[] {
  const out: PersonBadge[] = [];
  for (const d of detection.people) {
    if (out.length >= 2) break;
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
