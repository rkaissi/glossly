// Person resolution (spec: People layer). Never merges: a fuzzy hit is only a suggestion the
// user confirms ("Is this the same Sam?").
import { canonicalize, jaroWinkler } from './names';

export interface PeopleLookup {
  byAlias(kind: 'email' | 'handle', value: string): string | null;
  byName(name: string): string | null;
  nameIndex(): { personId: string; names: string[] }[];
  seenIn(sourceApp: string): Set<string>;
}

export interface PersonCandidate {
  name: string | null;
  email?: string | null;
  handle?: string | null;
  knownId?: string | null;
}

export type Resolution =
  | { kind: 'exact'; personId: string; via: 'known' | 'email' | 'handle' | 'name' }
  | { kind: 'fuzzy'; personId: string; score: number }
  | { kind: 'none' };

export const FUZZY_THRESHOLD = 0.92;

/**
 * 1. exact email or handle alias, 2. exact full name (or name alias), 3. fuzzy name match
 * (Jaro-Winkler above 0.92) among people seen in the same app, 4. none.
 */
export function resolvePerson(lookup: PeopleLookup, c: PersonCandidate, sourceApp: string, threshold = FUZZY_THRESHOLD): Resolution {
  if (c.knownId) return { kind: 'exact', personId: c.knownId, via: 'known' };
  if (c.email) {
    const id = lookup.byAlias('email', c.email);
    if (id) return { kind: 'exact', personId: id, via: 'email' };
  }
  // Chat speakers are often handles ("tomas"), so a name is tried as a handle too.
  for (const h of [c.handle, c.name && !c.name.includes(' ') ? c.name : null]) {
    if (!h) continue;
    const id = lookup.byAlias('handle', h);
    if (id) return { kind: 'exact', personId: id, via: 'handle' };
  }
  if (!c.name) return { kind: 'none' };
  const exact = lookup.byName(c.name);
  if (exact) return { kind: 'exact', personId: exact, via: 'name' };

  const target = canonicalize(c.name);
  const seen = sourceApp ? lookup.seenIn(sourceApp) : new Set<string>();
  let best: { personId: string; score: number } | null = null;
  for (const p of lookup.nameIndex()) {
    if (!seen.has(p.personId)) continue;
    for (const n of p.names) {
      const score = jaroWinkler(target, n);
      if (score > threshold && (!best || score > best.score)) best = { personId: p.personId, score };
    }
  }
  if (best) return { kind: 'fuzzy', ...best };
  const first = firstNameMatch(lookup, target, seen);
  return first ? { kind: 'fuzzy', personId: first, score: FIRST_NAME_SCORE } : { kind: 'none' };
}

/** Score reported for a first-name match; it is a question for the user, not a measure. */
export const FIRST_NAME_SCORE = 0.9;

/**
 * One side is only a first name ("Jordan" for a saved "Jordan Hale", or the reverse): a
 * saved person with that first name is offered as "Is this the same Jordan?" instead of a
 * duplicate. In any app, since chats and sign-offs often show only a first name. Several
 * matches prefer someone seen in this app.
 */
function firstNameMatch(lookup: PeopleLookup, target: string, seen: Set<string>): string | null {
  const firstOf = (n: string) => n.split(' ')[0]!;
  const first = firstOf(target);
  if (first.length < 3) return null;
  const single = !target.includes(' ');
  const matches = lookup
    .nameIndex()
    .filter((p) => p.names.some((n) => n !== target && (single || !n.includes(' ')) && firstOf(n) === first))
    .map((p) => p.personId);
  return matches.find((id) => seen.has(id)) ?? matches[0] ?? null;
}
