// Code's half of the conversation read (decision 48): the model says who wrote each message in the
// selection and where it starts; code keeps only what it can find in the text (decision 22's
// rule) and falls back to the local header parser for anything it can't.
import { isHeaderChrome, knownName, lastSpeaker } from '../router/features';
import type { Identity } from '../settings';
import type { DetectedPerson, DetectInput } from './detect';
import { canonicalize, hasIdentity, isMe } from './names';
import { isUiLabel } from './who-judge';

/** At most this many messages are read; a longer selection keeps its last ones. */
export const READ_MAX_MESSAGES = 8;

/** A message as the model wrote it: its author, whether it's the user's, and its first words. */
export interface MessageRow {
  author: string;
  user: boolean;
  starts: string;
}

/** A message in the selection, accepted by code. */
export interface ReadMessage {
  /** Who wrote it, as written in the text; null when neither the model nor the parser could tell. */
  author: string | null;
  /** The user wrote it. */
  user: boolean;
  /** Where its text starts in the selection. */
  start: number;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Where `starts` begins in `text` at or after `from`, with any whitespace between its words; -1 if absent. */
function findStart(text: string, starts: string, from: number): number {
  const words = starts.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return -1;
  const re = new RegExp(words.map(escape).join('\\s+'), 'g');
  re.lastIndex = from;
  const exact = re.exec(text);
  if (exact) return exact.index;
  const loose = new RegExp(re.source, 'gi');
  loose.lastIndex = from;
  return loose.exec(text)?.index ?? -1;
}

const squash = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();

/** A name the model gave is a real author when it's in the captured text or the title, and isn't a UI label. */
function groundedAuthor(author: string, input: DetectInput): boolean {
  const a = squash(author);
  if (!a || a.length > 60 || isUiLabel(author)) return false;
  return [input.window_title, input.before, input.text, input.after].some((s) => squash(s).includes(a));
}

/** The line that starts a quoted earlier email: "On Tue, … wrote:", "-----Original Message-----", or a From: line followed by Sent:. */
export const QUOTE_HEADER = /^[ \t>]*(?:On\b[^\n]{0,200}\bwrote:|-{2,}\s*Original Message\s*-{2,}|From:[^\n]*\n[ \t>]*Sent:)/im;

/**
 * Where an email chain's quoted history starts in the selection, or -1. An email quotes older
 * messages under the newest one, so the text above this is the latest message (Step 21: Reply
 * on a whole chain answered the oldest quoted ask). A header at the very top is a forwarded or
 * pasted message, not a reply's quote, and doesn't count.
 */
export function quoteStart(text: string): number {
  const m = QUOTE_HEADER.exec(text);
  return m && text.slice(0, m.index).trim() ? m.index : -1;
}

/** "You" and "Me" are how some apps label the user's own messages (WhatsApp, Messenger). */
const SELF_LABEL = /^(?:you|me)$/i;

/**
 * The model's messages, kept only where code agrees: each start found in the selection, in
 * order; each author found in the text and not a UI label (else the local parser's speaker
 * there); `user` checked with `isMe` when the user's name is set. Null when none survive, so
 * callers use the local parser for the whole selection.
 */
export function acceptMessages(rows: MessageRow[], input: DetectInput, me: Identity): ReadMessage[] | null {
  const known = knownName(me);
  const out: ReadMessage[] = [];
  let from = 0;
  for (const row of rows) {
    const start = findStart(input.text, row.starts, from);
    if (start < 0) continue;
    from = start + 1;
    const name = row.author.trim();
    const author = name && groundedAuthor(name, input) ? name : lastSpeaker(`${input.before}${input.text.slice(0, start)}`, known);
    // Code has the last word on the user: the model's guess counts only when there's no name to check.
    const user = author ? isMe(author, me) || SELF_LABEL.test(author) || (row.user && !hasIdentity(me)) : row.user && !hasIdentity(me);
    out.push({ author, user, start });
  }
  // In an email chain only the newest message counts: the quoted ones below it are history.
  const cut = quoteStart(input.text);
  const kept = cut > 0 && out[0]!.start < cut ? out.filter((m) => m.start < cut) : out;
  if (!kept.length) return null;
  // The first message owns the text before its start (a header, or the end of an earlier message).
  kept[0]!.start = 0;
  return kept.slice(-READ_MAX_MESSAGES);
}

/** A message's text without the next message's header at its end (its author's name, badge, and time lines). */
function withoutNextHeader(text: string, nextAuthor: string | null | undefined): string {
  const lines = text.trimEnd().split(/\r?\n/);
  const next = nextAuthor?.trim().toLowerCase();
  while (lines.length > 1) {
    const last = lines.at(-1)!.trim();
    // The next writer's name alone, or with its time on the same line (Slack's "Name  9:41 AM").
    const sameLine = next && last.toLowerCase().startsWith(next) && isHeaderChrome(last.slice(next.length).replace(/^[\s—–-]+/, ''));
    if (!last || isHeaderChrome(last) || (next && last.toLowerCase() === next) || sameLine) lines.pop();
    else break;
  }
  return lines.join('\n').trim();
}

/** The selection cut into its messages, in order, each without the next one's header. */
export function splitMessages(text: string, messages: ReadMessage[]): { author: string | null; user: boolean; text: string }[] {
  return messages.map((m, i) => {
    const next = messages[i + 1];
    return { author: m.author, user: m.user, text: withoutNextHeader(text.slice(m.start, next?.start ?? text.length), next?.author) };
  });
}

/**
 * Who wrote the selected message, from the read: the last message's author. Its email and
 * handle come from the people the same read found. Null when the read has no author.
 */
export function readAuthor(messages: ReadMessage[] | null, people: DetectedPerson[]): { author: DetectedPerson | null; authorIsMe: boolean } | null {
  const last = messages?.at(-1);
  if (!last || (!last.author && !last.user)) return null;
  if (last.user) return { author: null, authorIsMe: true };
  const name = last.author!;
  const c = canonicalize(name);
  const match = people.find((p) => (p.name && canonicalize(p.name) === c) || (p.handle && p.handle === c.replace(/^@/, '')));
  return {
    author: match ? { ...match, role: 'author' } : { name, email: null, handle: null, role: 'author', knownId: null },
    authorIsMe: false,
  };
}

/** The people list with the read's author first, added when the people rows left them out. */
export function authorFirst(people: DetectedPerson[], author: DetectedPerson | null): DetectedPerson[] {
  if (!author) return people;
  const same = (p: DetectedPerson) => p === author || (p.name && author.name && canonicalize(p.name) === canonicalize(author.name)) || (p.email && p.email === author.email);
  const rest = people.filter((p) => !same(p));
  const found = people.find(same);
  return [found ? { ...found, role: 'author' } : author, ...rest];
}
