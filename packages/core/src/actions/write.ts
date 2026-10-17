// Write here (Step 27, decision 81): text for the spot at the caret, written as the user from
// everything they saved. It takes Reply's context and voice: the saved notes, memories, people,
// tasks, and events closest to what is being written (decision 77), the person written to, voice
// samples, picked-up preferences, and style notes for this kind of place. With text before the
// caret it continues it; with a request it writes that. Streamed on the Chat role, and shown in
// an editable box before anything is pasted. The plain snippet list (paste.ts) is its no-model view.
import writePrompt from '../../prompts/write.md?raw';
import type { CalendarEvent } from '../calendar/types';
import { cleanText } from '../capture/clean';
import { contextLines, eventLabel, nowLine } from '../context/prompt';
import type { RetrievedContext } from '../context/retrieve';
import type { LlmProvider, StreamResult } from '../llm/types';
import { describeIdentity } from '../people/names';
import { describeSource, type ReplyChannel } from '../people/reply-style';
import type { CommitmentView, PersonCard, VoiceForPrompt } from '../people/types';
import type { Settings } from '../settings';
import type { Item, Surroundings } from '../types';
import { markCursor } from './ask';
import type { PasteTarget, WriteAsk, WriteSuggestion } from './paste-types';
import { personSection } from './reply';

export { WRITE_ASKS, type WriteAsk, type WriteSuggestion } from './paste-types';

/** The model's answer when nothing useful can be written (no request, no clue, nothing that fits). The panel's `written.ts` hides it. */
export const NOTHING_TO_WRITE = '[nothing to write]';

const MAX_SURROUNDINGS = 3000;
const MAX_NOTE = 1200;
const MAX_NOTES = 8;
const MAX_VOICE = 3;
const MAX_VOICE_CHARS = 300;
const MAX_REQUEST = 500;
const MAX_PREVIOUS = 2500;
/** A chat message stays short; a document can take a page. Reasoning stays low. */
export const WRITE_MAX_OUTPUT: Record<PasteTarget, number> = { chat: 350, email: 800, document: 1200, code: 700, other: 800 };

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();

const TARGET_WORDS: Record<PasteTarget, string> = {
  email: 'an email',
  chat: 'a chat message',
  document: 'a document',
  code: 'a code editor',
  other: 'an app (kind unknown)',
};
const PLATFORM: Record<ReplyChannel, string> = { email: 'email', messaging: 'messaging app', work_chat: 'work chat', document: 'document', other: 'other app' };
const ASK_LINES: Record<WriteAsk, string> = {
  shorter: 'Shorter.',
  longer: 'Longer and fuller.',
  casual: 'More casual.',
  formal: 'More formal.',
};

/** A saved note for the prompt: a snippet picked for this spot, or one retrieval found close to it. */
export interface WriteNote {
  id: string;
  text: string;
  why?: string | null;
  created_at?: string | null;
}

export interface WriteInput {
  target: PasteTarget;
  /** A rich-text editor keeps its own list style, so list items go in as plain lines (`richEditor`). */
  rich: boolean;
  app: string;
  title: string;
  surroundings: Surroundings | null;
  /** What the user asked for ("agenda for Thursday's review"); null to continue the text at the caret. */
  request?: string | null;
  /** Who the text is to: the sender of the quoted email or the chat being written in, with their record when it resolved. */
  to?: { name: string; person: PersonCard | null } | null;
  /** Saved notes (snippets and memories) close to this spot, most fitting first (`mergeWriteNotes`). */
  notes: WriteNote[];
  /** Saved people, tasks, and events close to the text (decision 77); the person written to is `to`. */
  context?: Pick<RetrievedContext, 'people' | 'tasks' | 'events'> | null;
  /** Up to 3 samples of how the user writes, from this kind of place first. */
  voice: (string | VoiceForPrompt)[];
  /** What the user tends to pick, one line each (`preferenceLine`). */
  preferences?: string[];
  /** Style notes written from the user's edits and requests (Profile). */
  styleNotes?: string[];
  /** "Shorter", "More casual", or typed words, applied to the text written before. */
  change?: { previous: string; asks: WriteAsk[]; note?: string | null } | null;
}

/**
 * The notes for the prompt: the snippets picked for the spot first (they were chosen for it),
 * then the ones retrieval found, without repeats, at most MAX_NOTES.
 */
export function mergeWriteNotes(snippets: Pick<Item, 'id' | 'text' | 'why' | 'created_at'>[], recalled: { itemId: string; text: string; why: string | null; created_at: string }[]): WriteNote[] {
  const seen = new Set<string>();
  const out: WriteNote[] = [];
  for (const n of [...snippets.map((s) => ({ ...s })), ...recalled.map((r) => ({ id: r.itemId, text: r.text, why: r.why, created_at: r.created_at }))]) {
    if (seen.has(n.id)) continue;
    seen.add(n.id);
    out.push(n);
  }
  return out.slice(0, MAX_NOTES);
}

/** Where the text goes and what is around the cursor, with the cursor kept inside the window. */
function writingSection(s: Surroundings | null): string[] {
  if (!s?.text.trim()) return ['## What the user is writing', 'Nothing yet: the field is empty or could not be read.'];
  const marked = markCursor(s);
  const at = s.caret >= 0 ? s.caret : 0;
  const start = Math.max(0, Math.min(at - Math.floor(MAX_SURROUNDINGS * 0.7), marked.length - MAX_SURROUNDINGS));
  return [
    s.source === 'caret' ? '## What the user is writing ([CURSOR] marks where the text goes)' : '## What is on the screen (no cursor found)',
    '<context>',
    marked.slice(start, start + MAX_SURROUNDINGS),
    '</context>',
  ];
}

export function buildWritePrompt(settings: Pick<Settings, 'identity'>, input: WriteInput, now: Date = new Date()): string {
  // Stable parts first (the user, voice, preferences, notes), so a provider's prompt cache reuses them.
  const parts = ['## The user', describeIdentity(settings.identity) ?? 'Unknown.', '', '## Voice samples (how the user writes)'];
  const voice = input.voice.slice(0, MAX_VOICE);
  if (voice.length)
    voice.forEach((v) => {
      const s = typeof v === 'string' ? { text: v, from: null } : v;
      parts.push(s.from ? `<sample from="${PLATFORM[s.from]}">` : '<sample>', clip(s.text, MAX_VOICE_CHARS), '</sample>');
    });
  else parts.push('None yet. Keep it natural and plain.');
  if (input.preferences?.length) parts.push('', '## What the user tends to pick', ...input.preferences.map((p) => `- ${p}`));
  if (input.styleNotes?.length) parts.push('', '## Notes on how the user writes', ...input.styleNotes.map((n) => `- ${n}`));

  parts.push('', '## Where the text goes', `${TARGET_WORDS[input.target]}: ${describeSource(input.app, input.title)}`);
  if (input.rich) parts.push('The editor keeps its own lists: write list items as plain lines.');
  parts.push('', '## Now', nowLine(now));
  if (input.to) parts.push('', '## Writing to', input.to.name, ...(input.to.person ? ['', ...personSection(input.to.person)] : []));

  const toId = input.to?.person?.id ?? null;
  const ctx = input.context;
  const lines = ctx
    ? contextLines(
        {
          people: ctx.people.filter((p) => p.id !== toId),
          tasks: ctx.tasks.filter((c) => !(toId && c.person_id === toId && c.status === 'open')),
          events: ctx.events,
        },
        now,
      )
    : [];
  if (lines.length) parts.push('', "## What the user has saved (private to the user; labels in brackets are worked out from now)", ...lines);
  if (input.notes.length) {
    parts.push('', '## Saved notes');
    input.notes.forEach((n, i) => {
      parts.push(n.created_at ? `<note n="${i + 1}" saved="${n.created_at.slice(0, 10)}">` : `<note n="${i + 1}">`, clip(cleanText(n.text), MAX_NOTE));
      if (n.why) parts.push(`Why it was saved: ${clip(oneLine(n.why), 200)}`);
      parts.push('</note>');
    });
  }

  parts.push('', ...writingSection(input.surroundings));
  const request = input.request?.trim();
  if (request) parts.push('', '## What the user asked for', `"${clip(oneLine(request), MAX_REQUEST)}"`);
  const change = input.change;
  if (change && (change.asks.length || change.note?.trim())) {
    parts.push('', '## The text written before', '<previous>', clip(change.previous, MAX_PREVIOUS), '</previous>', '', '## Change it');
    change.asks.forEach((a) => parts.push(`- ${ASK_LINES[a]}`));
    if (change.note?.trim()) parts.push(`- In their words: "${clip(oneLine(change.note), MAX_REQUEST)}"`);
  }
  return parts.join('\n');
}

/** Streams the text on the Chat role, action "write". Local only refuses in the LLM layer. */
export function write(llm: LlmProvider, settings: Pick<Settings, 'identity'>, input: WriteInput, signal?: AbortSignal): StreamResult {
  return llm.stream({
    role: 'chat',
    action: 'write',
    instructions: writePrompt,
    prompt: buildWritePrompt(settings, input),
    signal,
    maxOutputTokens: WRITE_MAX_OUTPUT[input.target],
    reasoning: 'low',
    // One text, not three drafts: steady from run to run (Rayan, Oct 17: "sometimes it shows nothing and sometimes it gives something").
    temperature: 0.3,
  });
}

export interface SuggestInput {
  target: PasteTarget;
  /** Saved events; only the ones still ahead in the next week count. */
  events: Pick<CalendarEvent, 'title' | 'starts_at' | 'ends_at' | 'all_day'>[];
  /** Open tasks. */
  tasks: Pick<CommitmentView, 'text' | 'owner' | 'status' | 'due_at' | 'person_name'>[];
  /** Saved items recent enough to paste. */
  recent: number;
}

const SUGGEST_DAYS = 7;
const MAX_LABEL_TITLE = 32;
const MAX_TASKS_IN_REQUEST = 6;

const startOf = (s: string) => new Date(s.length === 10 ? `${s}T12:00:00` : s);
const midnight = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
const firstName = (name: string) => name.trim().split(/\s+/)[0] ?? name;

/** "today's", "tomorrow's", "Thu's". */
function dayPossessive(d: Date, now: Date): string {
  const n = Math.round((midnight(d) - midnight(now)) / 86_400_000);
  if (n === 0) return "today's";
  if (n === 1) return "tomorrow's";
  return `${new Intl.DateTimeFormat('en-US', { weekday: 'short' }).format(d)}'s`;
}

/**
 * Up to three things to write in an empty field: the next event in the week (an agenda in a
 * document, an email or message about it elsewhere), an update on open tasks owed to one person
 * (or on the user's own open tasks), and the newest snippets. Built in code, so showing them
 * costs no call.
 */
export function writeSuggestions(input: SuggestInput, now: Date = new Date()): WriteSuggestion[] {
  const out: WriteSuggestion[] = [];
  const t = now.getTime();
  const next = input.events
    .filter((e) => {
      const start = startOf(e.starts_at);
      const end = e.ends_at ? startOf(e.ends_at) : start;
      const ahead = e.all_day ? midnight(start) >= midnight(now) : Math.max(start.getTime(), end.getTime()) > t;
      return ahead && midnight(start) - midnight(now) < SUGGEST_DAYS * 86_400_000;
    })
    .sort((a, b) => startOf(a.starts_at).getTime() - startOf(b.starts_at).getTime())[0];
  if (next) {
    const title = oneLine(next.title);
    const when = dayPossessive(startOf(next.starts_at), now);
    const what = input.target === 'email' ? 'Email about' : input.target === 'chat' ? 'Message about' : 'Agenda for';
    const asked = input.target === 'email' ? 'An email about' : input.target === 'chat' ? 'A message about' : 'An agenda for';
    out.push({ kind: 'event', label: `${what} ${when} ${clip(title, MAX_LABEL_TITLE)}`, request: `${asked} "${title}" (${eventLabel(next, now)})` });
  }

  const open = input.tasks.filter((c) => c.status === 'open' && c.owner === 'me');
  const byPerson = new Map<string, typeof open>();
  for (const c of open) if (c.person_name) byPerson.set(c.person_name, [...(byPerson.get(c.person_name) ?? []), c]);
  const due = (c: (typeof open)[number]) => (c.due_at ? startOf(c.due_at).getTime() : Infinity);
  const person = [...byPerson.entries()].sort((a, b) => b[1].length - a[1].length || Math.min(...a[1].map(due)) - Math.min(...b[1].map(due)))[0];
  const list = (cs: typeof open) => cs.slice(0, MAX_TASKS_IN_REQUEST).map((c) => oneLine(c.text)).join('; ');
  if (person) {
    const [name, cs] = person;
    out.push({ kind: 'task', label: `Update for ${firstName(name)} on ${cs.length} open task${cs.length === 1 ? '' : 's'}`, request: `An update for ${name} on what I owe them: ${list(cs)}` });
  } else if (open.length >= 2) {
    out.push({ kind: 'task', label: `Status of your ${open.length} open tasks`, request: `A status update on my open tasks: ${list(open)}` });
  }

  if (input.recent >= 2) {
    const n = Math.min(input.recent, 5);
    out.push({ kind: 'snippets', label: `Notes from your ${n} newest snippets`, request: `Notes from my ${n} newest saved snippets` });
  }
  return out.slice(0, 3);
}
