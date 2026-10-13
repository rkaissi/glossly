// Code's half of Who is this. The model proposes rows; this file keeps or drops them.
// With no model, a strict local pass keeps only addresses, handles, headers, sign-offs, and speakers.
import { knownName, speakers } from '../router/features';
import type { Identity } from '../settings';
import type { DetectedPerson, DetectInput } from './detect';
import { findEmails, isRoleAddress } from './emails';
import { asRelationship } from './relationship';
import { canonicalize, isMe, normalizeEmail, normalizeHandle } from './names';

export const WHO_MIN_CONFIDENCE = 0.7;
export const WHO_MAX_PEOPLE = 8;

export interface WhoCandidate {
  name: string;
  email: string;
  handle: string;
  role: string;
  about: string;
  /** One of RELATIONSHIPS. Optional: the local pass never guesses. */
  relationship?: string;
  confidence: number;
  evidence: string;
}

const handleRe = () => /(?:^|[\s(])@([A-Za-z0-9_][\w.-]{1,30})/g;
const headerRe = () => /^\s*(from|to|cc|bcc):\s*(.+)$/gim;
/** Button labels the model must not turn into people. Matched on the whole name. */
const NOT_PEOPLE = new Set([
  'reply',
  'forward',
  'reactions',
  'reaction',
  'add reaction',
  'edit',
  'more',
  'cc',
  'bcc',
  'sorted',
  'reactions reply',
  'edit edit',
  'forward forward',
  'reply reply',
  'more more',
]);
/** Chrome that is never a message's author: buttons, Discord's "Server Tag" and its badges ("GEN2"), field labels. */
const LABELS = /^(?:server tag|tag|role|pronouns|bot|app|new|edited|pinned|from|to|subject|date)$/i;
export function isUiLabel(name: string): boolean {
  const n = name.trim();
  return NOT_PEOPLE.has(canonicalize(n)) || LABELS.test(n) || /^(?=.*\d)[A-Z0-9]{2,6}$/.test(n) || /^server tag:/i.test(n);
}

const NOT_NAMES = /^(?:thanks|thank you|thx|hi|hey|hello|dear|cc|bcc|to|from|ping|via|cheers|best|regards)$/i;
const SIGN_OFF =
  /(?:^|\n)\s*(?:thanks|thank you|many thanks|best|best regards|kind regards|regards|cheers|sincerely|warmly|talk soon|all the best|thx)[,!.]?\s*\n+\s*([A-Z][\p{L}'’.-]+(?:\s+[A-Z][\p{L}'’.-]+)?)\s*$/iu;

/** 0 to 1. A model that answers in percent (85) is read as 0.85. */
function confidenceOf(c: number): number {
  if (!Number.isFinite(c) || c < 0) return 0;
  return c > 1 ? Math.min(c / 100, 1) : c;
}

export function whoCorpus(input: DetectInput): string {
  return [input.window_title, input.before, input.text, input.after].filter((s) => s.trim()).join('\n');
}

const tokensOf = (s: string) => canonicalize(s).split(/[\s-]+/).filter(Boolean);

const squash = (s: string) => s.replace(/\s+/g, ' ').trim();

function present(corpus: string, value: string): boolean {
  const v = squash(value).toLowerCase();
  return v.length > 0 && squash(corpus).toLowerCase().includes(v);
}

/** True when every token of `short` appears, in order, inside `long`. */
function isFragment(short: string[], long: string[]): boolean {
  if (!short.length || short.length >= long.length) return false;
  let i = 0;
  for (const t of long) {
    if (t === short[i]) i++;
    if (i === short.length) return true;
  }
  return false;
}

function mergeInto(keep: WhoCandidate, drop: WhoCandidate, preferName: string): void {
  if (tokensOf(preferName).length > tokensOf(keep.name).length) keep.name = preferName;
  if (!keep.email && drop.email) keep.email = drop.email;
  if (!keep.handle && drop.handle) keep.handle = drop.handle;
  if (!keep.role && drop.role) keep.role = drop.role;
  if (!keep.about && drop.about) keep.about = drop.about;
  if (!asRelationship(keep.relationship) && asRelationship(drop.relationship)) keep.relationship = drop.relationship;
  keep.confidence = Math.max(keep.confidence, drop.confidence);
}

/** "Sam", "Sam Smith", and "Smith" from one "Sam Smith" become the longest form. */
function mergeFragments(rows: WhoCandidate[]): WhoCandidate[] {
  const out: WhoCandidate[] = [];
  for (const row of rows) {
    const tokens = tokensOf(row.name);
    const hit = out.find((o) => {
      const ot = tokensOf(o.name);
      return isFragment(tokens, ot) || isFragment(ot, tokens) || (row.handle && normalizeHandle(row.handle) === canonicalize(o.name)) || (o.handle && normalizeHandle(o.handle) === canonicalize(row.name));
    });
    if (!hit) {
      out.push({ ...row });
      continue;
    }
    const longer = tokensOf(row.name).length > tokensOf(hit.name).length ? row.name : hit.name;
    mergeInto(hit, row, longer);
  }
  return out;
}

/**
 * "Priya Shah; Lena Ortiz" or "Priya Shah, Lena Ortiz". A comma between two single words is
 * read as "Shah, Priya" and kept whole.
 */
function recipients(list: string): string[] {
  return list.split(';').flatMap((part) => {
    const pieces = part.split(',');
    const lastFirst = pieces.length === 2 && pieces.every((p) => /^\s*[\p{L}'’.-]+\s*$/u.test(p));
    return lastFirst ? [part] : pieces;
  });
}

function headerNames(corpus: string): { name: string | null; email: string | null }[] {
  const out: { name: string | null; email: string | null }[] = [];
  for (const line of corpus.matchAll(headerRe())) {
    for (const part of recipients(line[2]!)) {
      const raw = part.trim();
      if (!raw) continue;
      const found = findEmails(raw)[0];
      let email = found ? normalizeEmail(found.email) : null;
      let rest = raw;
      if (found) {
        // Letters stuck to the domain ("…example.comJordan") are not part of the name either.
        const glue = /^[A-Za-z]+/.exec(raw.slice(found.end))?.[0].length ?? 0;
        rest = raw.slice(0, found.index) + raw.slice(found.end + glue);
      }
      const name =
        rest
          .replace(/\([^)]{0,20}\)/g, '')
          .replace(/[<>]/g, '')
          .trim() || null;
      if (email && isRoleAddress(email)) email = null;
      if (!name && !email) continue;
      out.push({ name, email });
    }
  }
  return out;
}

/** The address, cut at the real domain, or "" when it is missing or a shared inbox. */
function repairedEmail(value: string): string {
  const found = findEmails(value)[0];
  if (!found || isRoleAddress(found.email)) return '';
  return normalizeEmail(found.email);
}

function neighborName(before: string): string | null {
  const cleaned = before.replace(/\([^)]{0,20}\)/g, ' ').replace(/[<>]/g, ' ').replace(/\s+/g, ' ').trim();
  const m = /([A-Z][\p{L}'’.-]+(?:\s+[A-Z][\p{L}'’.-]+){0,3})$/u.exec(cleaned);
  const name = m?.[1]?.trim() ?? null;
  // "Thanks @quinn" and "Hi @sam": the word before the handle is not their name.
  return name && !NOT_NAMES.test(name) ? name : null;
}

/**
 * Attaches an address to the person it sits next to. A bare address is not a person, and a
 * no-reply or scheduling inbox is not one either. @handles are still kept on their own.
 */
function attachContacts(rows: WhoCandidate[], corpus: string): WhoCandidate[] {
  const out = rows.map((r) => ({ ...r, email: repairedEmail(r.email) }));
  const take = (kind: 'email' | 'handle', value: string, before: string) => {
    const norm = kind === 'email' ? normalizeEmail(value) : normalizeHandle(value);
    if (kind === 'email' && isRoleAddress(norm)) return;
    if (out.some((r) => (kind === 'email' ? normalizeEmail(r.email) === norm : normalizeHandle(r.handle) === norm))) return;
    const near = neighborName(before);
    const name = near && !verbLike(near, corpus) ? near : null;
    const host = name ? out.find((r) => r.name && canonicalize(r.name) === canonicalize(name)) : undefined;
    if (host) {
      if (kind === 'email') host.email = norm;
      else host.handle = norm;
      return;
    }
    // An address with nobody's name next to it is not a person. A handle still is.
    if (kind === 'email' && !name) return;
    out.push({
      name: name ?? '',
      email: kind === 'email' ? norm : '',
      handle: kind === 'handle' ? norm : '',
      role: '',
      about: '',
      confidence: 1,
      evidence: value,
    });
  };
  for (const m of findEmails(corpus)) take('email', m.email, corpus.slice(Math.max(0, m.index - 80), m.index));
  for (const m of corpus.matchAll(handleRe())) take('handle', m[1]!, corpus.slice(Math.max(0, m.index! - 80), m.index));
  return mergeFragments(out);
}

function dropUser(rows: WhoCandidate[], corpus: string, me: Identity): WhoCandidate[] {
  const userForms = [...headerNames(corpus).map((h) => h.name), ...rows.map((r) => r.name)].filter((n): n is string => Boolean(n && isMe(n, me)));
  return rows.filter((r) => {
    if (isMe(r.name, me) || isMe(r.email, me) || isMe(r.handle, me)) return false;
    const tokens = tokensOf(r.name);
    return !userForms.some((form) => isFragment(tokens, tokensOf(form)));
  });
}

function toDetected(r: WhoCandidate): DetectedPerson | null {
  const rawName = r.name.trim();
  // A row whose "name" is an address is not a person. The address can still attach to someone else.
  const name = rawName && !rawName.includes('@') ? rawName : null;
  const email = repairedEmail(r.email);
  const handle = r.handle.trim() ? normalizeHandle(r.handle) : null;
  // An address with no name is not a person. A handle still is.
  if (!name && !handle) return null;
  return {
    name,
    email: email || null,
    handle,
    role: 'mentioned',
    knownId: null,
    detail: r.role.trim() || null,
    about: r.about.trim() || null,
    relationship: asRelationship(r.relationship),
  };
}

/**
 * Keeps the model's rows that are actually in the text. Drops low confidence, invented
 * people, the user, and fragments of one name. An address attaches to the neighboring
 * name; a bare or shared inbox does not become a person. @handles are kept.
 */
/**
 * A one-word "name" that is a verb in the text: it ends in -ing, and every time it appears it
 * starts a sentence and the next word is lowercase or an address ("Copying finance@example.com",
 * "Looping in Casey"). Step 21: Who listed "Copying" as a person. "We met Sterling at" is a name.
 */
function verbLike(name: string, corpus: string): boolean {
  const n = name.trim();
  if (!/^[A-Z][a-z]{3,}ing$/.test(n)) return false;
  const uses = [...corpus.matchAll(new RegExp(String.raw`(^|[.!?:]\s+|\n\s*)?\b${n}\b[ \t]+(\S+)`, 'g'))];
  return uses.length > 0 && uses.every((m) => (m.index === 0 || m[1] !== undefined) && (/^[a-z]/.test(m[2]!) || m[2]!.includes('@')));
}

export function acceptWhoRows(rows: WhoCandidate[], corpus: string, me: Identity): DetectedPerson[] {
  const flat = squash(corpus);
  const grounded = rows.filter((r) => {
    if (confidenceOf(r.confidence) < WHO_MIN_CONFIDENCE) return false;
    if (NOT_PEOPLE.has(canonicalize(r.name)) || verbLike(r.name, corpus)) return false;
    // A quote that spans a line break comes back with a space: compare with whitespace squashed.
    const evidence = squash(r.evidence);
    if (!evidence || !flat.includes(evidence)) return false;
    return present(corpus, r.name) || present(corpus, r.email) || present(corpus, r.handle.replace(/^@+/, ''));
  });
  const merged = dropUser(attachContacts(mergeFragments(grounded), corpus), corpus, me);
  const people: DetectedPerson[] = [];
  for (const row of merged) {
    if (people.length >= WHO_MAX_PEOPLE) break;
    const d = toDetected(row);
    if (!d || isMe(d.name, me) || isMe(d.email, me) || isMe(d.handle, me)) continue;
    people.push(d);
  }
  return people;
}

function addLocal(found: Map<string, WhoCandidate>, row: WhoCandidate, me: Identity): void {
  if (isMe(row.name, me) || isMe(row.email, me) || isMe(row.handle, me)) return;
  const key = row.email ? `e:${normalizeEmail(row.email)}` : row.handle ? `h:${normalizeHandle(row.handle)}` : `n:${canonicalize(row.name)}`;
  if (key.endsWith(':')) return;
  const prev = found.get(key);
  if (prev) mergeInto(prev, row, tokensOf(row.name).length > tokensOf(prev.name).length ? row.name : prev.name);
  else found.set(key, { ...row });
}

/**
 * No model. Emails, @handles (including the window title), From/To/Cc, sign-offs, and real
 * speakers only. A bare capitalized pair is not a person, and no role is invented.
 */
export function localWho(input: DetectInput, me: Identity): DetectedPerson[] {
  const corpus = whoCorpus(input);
  const found = new Map<string, WhoCandidate>();
  const blank = { role: '', about: '', confidence: 1 };
  for (const h of headerNames(corpus)) {
    addLocal(found, { name: h.name ?? '', email: h.email ?? '', handle: '', evidence: h.email ?? h.name ?? '', ...blank }, me);
  }
  const sign = SIGN_OFF.exec(input.text.trimEnd());
  if (sign) addLocal(found, { name: sign[1]!, email: '', handle: '', evidence: sign[1]!, ...blank }, me);
  for (const name of speakers(corpus, knownName(me))) addLocal(found, { name, email: '', handle: '', evidence: name, ...blank }, me);
  const people = acceptWhoRows([...found.values()], corpus, me).map((p) => ({ ...p, detail: null, about: null, relationship: null }));
  return people.slice(0, WHO_MAX_PEOPLE);
}
