// Finds the people in a selection without a model call: the author of the selected message
// (chat header, "From:" line, sign-off, or a DM window title) and the people it mentions
// (name pairs, emails, handles, and known people). The user's own names are left out.
import { extractFeatures, lastSpeaker } from '../router/features';
import type { KnownPerson } from '../router/types';
import type { Identity } from '../settings';
import { isRoleAddress } from './emails';
import type { Relationship } from './relationship';
import { canonicalize, isMe, normalizeEmail, normalizeHandle } from './names';

export interface DetectedPerson {
  name: string | null;
  email: string | null;
  handle: string | null;
  role: 'author' | 'mentioned';
  /** Set when the name or an alias of a known person appears in the text. */
  knownId: string | null;
  /** Model-written role ("recruiter at Northwind"). Blank on the local pass. */
  detail?: string | null;
  /** Model-written line about this person. Blank on the local pass. */
  about?: string | null;
  /** The model's guess at how the user knows them, to prefill Create person. Null on the local pass. */
  relationship?: Relationship | null;
}

export interface Detection {
  /** The author first (when found and not the user), then mentions. At most 6. */
  people: DetectedPerson[];
  author: DetectedPerson | null;
  /** The selected message was written by the user. */
  authorIsMe: boolean;
}

export interface DetectInput {
  text: string;
  /** Text before and after the selection (tier 2 when read, else tier 1). */
  before: string;
  after: string;
  source_app: string;
  window_title: string;
}

const MAX_PEOPLE = 6;
const NAME_EMAIL = /([A-Z][\p{L}'-]+(?:\s[A-Z][\p{L}'-]+){1,2})\s*<([\w.+-]+@[\w-]+(?:\.[\w-]+)+)>/gu;
const FROM_LINE = /^\s*From:\s*(.+?)\s*$/gim;
const SIGN_OFF =
  /(?:^|\n)\s*(?:thanks|thank you|many thanks|best|best regards|kind regards|regards|cheers|sincerely|warmly|talk soon|all the best|thx)[,!.]?\s*\n+\s*([A-Z][\p{L}'-]+(?:\s[A-Z][\p{L}'-]+)?)\s*$/iu;
const DM_TITLE = /^(.+?)\s+\(DM\)/;
const TEAMS_CHAT_TITLE = /^Chat \| (.+?) \| Microsoft Teams/;

function parseFrom(value: string): { name: string | null; email: string | null } {
  const angle = /^(.*?)\s*<([^>]+@[^>]+)>$/.exec(value);
  if (angle) return { name: angle[1]!.replace(/^"|"$/g, '').trim() || null, email: normalizeEmail(angle[2]!) };
  if (/^[\w.+-]+@[\w-]+(?:\.[\w-]+)+$/.test(value)) return { name: null, email: normalizeEmail(value) };
  return { name: value.replace(/^"|"$/g, '').trim() || null, email: null };
}

function findAuthor(input: DetectInput): { name: string | null; email: string | null } | null {
  const upToEnd = `${input.before}${input.text}`;
  // The last chat header up to the end of the selection is whoever wrote the last message in it.
  const speaker = lastSpeaker(upToEnd);
  if (speaker) return { name: speaker, email: null };

  const froms = [...upToEnd.matchAll(FROM_LINE)];
  const from = froms.at(-1)?.[1];
  if (from) return parseFrom(from);

  const sign = SIGN_OFF.exec(input.text.trimEnd());
  if (sign) return { name: sign[1]!, email: null };

  const title = DM_TITLE.exec(input.window_title) ?? TEAMS_CHAT_TITLE.exec(input.window_title);
  if (title) return { name: title[1]!.trim(), email: null };
  return null;
}

const keyOf = (p: Pick<DetectedPerson, 'name' | 'email' | 'handle'>) =>
  p.email ? `e:${p.email}` : p.handle ? `h:${p.handle}` : `n:${canonicalize(p.name ?? '')}`;

export function detectPeople(input: DetectInput, me: Identity, known: KnownPerson[] = []): Detection {
  const found = new Map<string, DetectedPerson>();
  const names = new Set<string>();
  const add = (p: DetectedPerson) => {
    if (found.size >= MAX_PEOPLE) return;
    if (isMe(p.name, me) || isMe(p.email, me) || isMe(p.handle, me)) return;
    const k = keyOf(p);
    if (k.endsWith(':') || found.has(k)) return;
    // "Helen Park" after "Helen Park <helen@...>" is the same person.
    if (p.name && names.has(canonicalize(p.name))) return;
    found.set(k, p);
    if (p.name) names.add(canonicalize(p.name));
  };

  const a = findAuthor(input);
  const authorIsMe = a !== null && (isMe(a.name, me) || isMe(a.email, me));
  const knownIdFor = (name: string | null, email: string | null) => {
    const vals = [name, email].filter(Boolean).map((v) => canonicalize(v!));
    return known.find((k) => [k.name, ...k.aliases].some((x) => vals.includes(canonicalize(x))))?.id ?? null;
  };
  let author: DetectedPerson | null = null;
  if (a && !authorIsMe) {
    author = { name: a.name, email: a.email, handle: null, role: 'author', knownId: knownIdFor(a.name, a.email) };
    add(author);
  }

  const text = input.text;
  for (const m of text.matchAll(NAME_EMAIL)) {
    const email = normalizeEmail(m[2]!);
    add({ name: m[1]!, email, handle: null, role: 'mentioned', knownId: knownIdFor(m[1]!, email) });
  }
  const f = extractFeatures(
    { text, context_before: '', context_after: '', source_app: input.source_app, window_title: input.window_title, is_editable: false },
    known,
  );
  for (const id of f.knownPeople) {
    const k = known.find((p) => p.id === id);
    if (k) add({ name: k.name, email: null, handle: null, role: 'mentioned', knownId: k.id });
  }
  for (const name of f.namePairs) add({ name, email: null, handle: null, role: 'mentioned', knownId: knownIdFor(name, null) });
  for (const email of f.emails) {
    const e = normalizeEmail(email);
    if (isRoleAddress(e)) continue;
    if (![...found.values()].some((p) => p.email === e)) add({ name: null, email: e, handle: null, role: 'mentioned', knownId: knownIdFor(null, e) });
  }
  for (const h of f.handles) add({ name: null, email: null, handle: normalizeHandle(h), role: 'mentioned', knownId: null });

  return { people: [...found.values()], author: author && found.has(keyOf(author)) ? author : null, authorIsMe };
}
