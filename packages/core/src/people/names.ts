// Pure name helpers for the people layer: canonical forms, fuzzy matching, and telling the
// user's own names, emails, and handles apart from everyone else's.
import type { Identity } from '../settings';

/** The normalized form used to match names and aliases. */
export function canonicalize(s: string): string {
  return s
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[’']/g, "'")
    .replace(/[^\p{L}\p{N}@.' +-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Handles are stored without "@", lower-case. */
export const normalizeHandle = (h: string) => h.trim().replace(/^@+/, '').toLowerCase();
export const normalizeEmail = (e: string) => e.trim().toLowerCase();

/** Jaro-Winkler similarity, 0 to 1 (spec: fuzzy person match above 0.92). */
export function jaroWinkler(a: string, b: string): number {
  if (a === b) return a.length ? 1 : 0;
  if (!a.length || !b.length) return 0;
  const range = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1);
  const aHit = new Array<boolean>(a.length).fill(false);
  const bHit = new Array<boolean>(b.length).fill(false);
  let matches = 0;
  for (let i = 0; i < a.length; i++) {
    const lo = Math.max(0, i - range);
    const hi = Math.min(b.length - 1, i + range);
    for (let j = lo; j <= hi; j++) {
      if (bHit[j] || a[i] !== b[j]) continue;
      aHit[i] = bHit[j] = true;
      matches++;
      break;
    }
  }
  if (!matches) return 0;
  let k = 0;
  let transpositions = 0;
  for (let i = 0; i < a.length; i++) {
    if (!aHit[i]) continue;
    while (!bHit[k]) k++;
    if (a[i] !== b[k]) transpositions++;
    k++;
  }
  const m = matches;
  const jaro = (m / a.length + m / b.length + (m - transpositions / 2) / m) / 3;
  let prefix = 0;
  while (prefix < 4 && prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
  return jaro + prefix * 0.1 * (1 - jaro);
}

export const hasIdentity = (id: Identity) => id.name.trim().length > 0;

/**
 * True when a speaker name, email, or handle is the user. A one-word speaker name also
 * matches the user's first name, since chat apps often show first names only.
 */
export function isMe(value: string | null | undefined, id: Identity): boolean {
  if (!value) return false;
  const v = value.trim();
  if (!v) return false;
  if (v.includes('@') && /\S@\S/.test(v)) return id.emails.some((e) => normalizeEmail(e) === normalizeEmail(v));
  const handle = normalizeHandle(v);
  if (id.handles.some((h) => normalizeHandle(h) === handle)) return true;
  const c = canonicalize(v);
  const mine = canonicalize(id.name);
  if (!c || !mine) return false;
  if (c === mine) return true;
  return !c.includes(' ') && c === mine.split(' ')[0];
}

/** "Rayan Kaissi (also: rayan@example.com, @rayan)", or null without an identity. */
export function describeIdentity(id: Identity): string | null {
  if (!hasIdentity(id)) return null;
  const also = [...id.emails.map(normalizeEmail), ...id.handles.map((h) => `@${normalizeHandle(h)}`)].filter(Boolean);
  return also.length ? `${id.name.trim()} (also: ${also.join(', ')})` : id.name.trim();
}
