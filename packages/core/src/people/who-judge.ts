// Code's half of Who is this. The model proposes rows; this file keeps or drops them.
// With no model, a strict local pass keeps only addresses, handles, headers, sign-offs, and speakers.
import { chatSpeaker } from '../router/features';
import type { Identity } from '../settings';
import type { DetectedPerson, DetectInput } from './detect';
import { canonicalize, isMe, normalizeEmail, normalizeHandle } from './names';

export const WHO_MIN_CONFIDENCE = 0.7;
export const WHO_MAX_PEOPLE = 8;

export interface WhoCandidate {
  name: string;
  email: string;
  handle: string;
  role: string;
  relation: string;
  confidence: number;
  evidence: string;
}

const emailRe = () => /[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/gi;
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
  if (!keep.relation && drop.relation) keep.relation = drop.relation;
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
      const email = raw.match(emailRe())?.[0] ?? null;
      const name = raw
        .replace(emailRe(), '')
        .replace(/\([^)]{0,20}\)/g, '')
        .replace(/[<>]/g, '')
        .trim();
      out.push({ name: name || null, email: email ? normalizeEmail(email) : null });
    }
  }
  return out;
}

function neighborName(before: string): string | null {
  const cleaned = before.replace(/\([^)]{0,20}\)/g, ' ').replace(/[<>]/g, ' ').replace(/\s+/g, ' ').trim();
  const m = /([A-Z][\p{L}'’.-]+(?:\s+[A-Z][\p{L}'’.-]+){0,3})$/u.exec(cleaned);
  const name = m?.[1]?.trim() ?? null;
  // "Thanks @quinn" and "Hi @sam": the word before the handle is not their name.
  return name && !NOT_NAMES.test(name) ? name : null;
}

/** Every email and @handle in the text is kept, attached to the neighboring name when there is one. */
function attachContacts(rows: WhoCandidate[], corpus: string): WhoCandidate[] {
  const out = rows.map((r) => ({ ...r }));
  const take = (kind: 'email' | 'handle', value: string, before: string) => {
    const norm = kind === 'email' ? normalizeEmail(value) : normalizeHandle(value);
    if (out.some((r) => (kind === 'email' ? normalizeEmail(r.email) === norm : normalizeHandle(r.handle) === norm))) return;
    const name = neighborName(before);
    const host = name ? out.find((r) => r.name && canonicalize(r.name) === canonicalize(name)) : undefined;
    if (host) {
      if (kind === 'email') host.email = norm;
      else host.handle = norm;
      return;
    }
    out.push({
      name: name ?? '',
      email: kind === 'email' ? norm : '',
      handle: kind === 'handle' ? norm : '',
      role: '',
      relation: '',
      confidence: 1,
      evidence: value,
    });
  };
  for (const m of corpus.matchAll(emailRe())) take('email', m[0], corpus.slice(Math.max(0, m.index! - 80), m.index));
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
  const name = r.name.trim() || null;
  const email = r.email.trim() ? normalizeEmail(r.email) : null;
  const handle = r.handle.trim() ? normalizeHandle(r.handle) : null;
  if (!name && !email && !handle) return null;
  return {
    name,
    email,
    handle,
    role: 'mentioned',
    knownId: null,
    detail: r.role.trim() || null,
    relation: r.relation.trim() || null,
  };
}

/**
 * Keeps the model's rows that are actually in the text. Drops low confidence, invented
 * people, the user, and fragments of one name. Emails and handles in the text are kept.
 */
export function acceptWhoRows(rows: WhoCandidate[], corpus: string, me: Identity): DetectedPerson[] {
  const flat = squash(corpus);
  const grounded = rows.filter((r) => {
    if (confidenceOf(r.confidence) < WHO_MIN_CONFIDENCE) return false;
    if (NOT_PEOPLE.has(canonicalize(r.name))) return false;
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

const TIME_LINE = /^(?:(?:today|yesterday)\s+at\s+)?\d{1,2}:\d{2}(?:\s?[AP]M)?$/i;

/** Speakers on their own line, with the time on the next line ("quinn" / "3:12 PM"). */
function loneSpeakers(corpus: string): string[] {
  const lines = corpus.split(/\r?\n/);
  const out: string[] = [];
  for (let i = 0; i < lines.length - 1; i++) {
    const name = lines[i]!.trim();
    const next = lines[i + 1]!.trim();
    if (/^[\p{L}][\p{L}\p{N}_.'-]{1,30}$/u.test(name) && TIME_LINE.test(next)) out.push(name);
  }
  return out;
}

/**
 * No model. Emails, @handles (including the window title), From/To/Cc, sign-offs, and real
 * speakers only. A bare capitalized pair is not a person, and no role is invented.
 */
export function localWho(input: DetectInput, me: Identity): DetectedPerson[] {
  const corpus = whoCorpus(input);
  const found = new Map<string, WhoCandidate>();
  const blank = { role: '', relation: '', confidence: 1 };
  for (const h of headerNames(corpus)) {
    addLocal(found, { name: h.name ?? '', email: h.email ?? '', handle: '', evidence: h.email ?? h.name ?? '', ...blank }, me);
  }
  const sign = SIGN_OFF.exec(input.text.trimEnd());
  if (sign) addLocal(found, { name: sign[1]!, email: '', handle: '', evidence: sign[1]!, ...blank }, me);
  for (const line of corpus.split(/\r?\n/)) {
    const speaker = chatSpeaker(line);
    if (speaker) addLocal(found, { name: speaker, email: '', handle: '', evidence: speaker, ...blank }, me);
  }
  for (const name of loneSpeakers(corpus)) addLocal(found, { name, email: '', handle: '', evidence: name, ...blank }, me);
  const people = acceptWhoRows([...found.values()], corpus, me).map((p) => ({ ...p, detail: null, relation: null }));
  return people.slice(0, WHO_MAX_PEOPLE);
}
