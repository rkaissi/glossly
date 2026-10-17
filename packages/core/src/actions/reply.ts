// Reply (spec: Actions, Reply with context): three intent-labeled drafts, streamed on the Chat
// role, written with what the user knows about the person and in the user's own voice.
import replyPrompt from '../../prompts/reply.md?raw';
import { contextLines, nowLine } from '../context/prompt';
import type { RetrievedContext } from '../context/retrieve';
import type { LlmProvider, StreamResult } from '../llm/types';
import { quoteStart, type ReadMessage } from '../people/conversation';
import type { DetectedPerson } from '../people/detect';
import { describeIdentity, isMe } from '../people/names';
import { headers, isHeaderChrome, knownName, lastSpeaker, type KnownName } from '../router/features';
import { describeSource, type ReplyChannel, type ReplyRedo, type ReplyRedoAsk } from '../people/reply-style';
import type { PersonCard, VoiceForPrompt } from '../people/types';
import type { Identity, Settings } from '../settings';
import type { ContainerContext, SelectionPayload } from '../types';

export interface ReplyInput {
  selection: SelectionPayload;
  container?: ContainerContext | null;
  author: DetectedPerson | null;
  authorIsMe: boolean;
  /** The author's record, when they resolved exactly. */
  person: PersonCard | null;
  /** Up to 3 samples of how the user writes, with the platform each was written on when known. */
  voice: (string | VoiceForPrompt)[];
  /** What the user tends to pick here, one line each with its evidence (`preferenceLine`). */
  preferences?: string[];
  /** Style notes written from the user's edits (Profile). */
  notes?: string[];
  /** "None of these": the drafts the user passed on and what they asked for instead. */
  redo?: ReplyRedo | null;
  /** Who wrote each message in the selection, from the conversation read; null uses the header parser (decision 48). */
  messages?: ReadMessage[] | null;
  /** The kind of platform, for the output cap; email gets room for full emails. */
  channel?: ReplyChannel;
  /** Opened from the reply box with nothing selected: the message is the text around the box (decision 75). */
  field?: boolean;
  /** Saved people, tasks, events, and notes close to the message (decision 77); the author's own record is `person`. */
  context?: Pick<RetrievedContext, 'people' | 'tasks' | 'events'> & { notes: { text: string }[] } | null;
}

const REDO_LINES: Record<ReplyRedoAsk, string> = {
  shorter: 'Shorter than these.',
  longer: 'Longer and fuller than these.',
  casual: 'More casual than these.',
  formal: 'More formal than these.',
  different: 'Different answers: do not repeat the intents of these drafts.',
};

const MAX_SELECTION = 6000;
/** The thread around the selection (decision 48: about 2,500 characters, mostly before it). */
const THREAD_BEFORE = 2000;
const THREAD_AFTER = 300;
const MAX_VOICE = 3;
const MAX_VOICE_CHARS = 300;
/** Three chat replies fit well inside this; three emails need more. Reasoning stays low (`reasoning`). */
export const REPLY_MAX_OUTPUT: Record<ReplyChannel, number> = { messaging: 450, work_chat: 450, email: 900, document: 900, other: 900 };
const SELECTION_MARK = '[SELECTION]';
const PLATFORM: Record<ReplyChannel, string> = { email: 'email', messaging: 'messaging app', work_chat: 'work chat', document: 'document', other: 'other app' };
const TARGET_MARK = '[REPLY TO THIS]';
/** Nothing was selected, so the message is the text around the reply box, which may end with the user's own start of a reply. */
const FIELD_NOTE =
  "The user opened Reply from the reply box itself, with nothing selected, so the messages below are the text around the box. Their last lines may be the user's own unfinished reply: never answer those, and keep any point they started.";

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);
const day = (iso: string) => {
  const d = new Date(iso.length === 10 ? `${iso}T12:00:00` : iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
};

/** The person record for the prompt: note, open commitments both ways, and recent messages. */
export function personSection(p: PersonCard): string[] {
  const out = [`## What you know about ${p.name}`];
  if (p.relationship) out.push(`Relationship to the user: ${p.relationship}`);
  if (p.note) out.push(`How the user knows them: ${clip(p.note, 400)}`);
  const due = (d: string | null) => (d ? ` (due ${day(d)})` : '');
  if (p.youOwe.length) out.push('The user owes them:', ...p.youOwe.map((c) => `- ${c.text}${due(c.due_at)}`));
  if (p.theyOwe.length) out.push('They owe the user:', ...p.theyOwe.map((c) => `- ${c.text}${due(c.due_at)}`));
  if (p.interactions.length) {
    out.push('Recent messages:', ...p.interactions.slice(0, 5).map((i) => `- ${day(i.occurred_at)}, ${i.direction === 'inbound' ? 'from them' : 'from the user'}: ${clip(i.text, 300)}`));
  }
  if (out.length === 1) out.push('Nothing saved yet.');
  return out;
}

/** The message to answer: `text` is `selection.slice(start)`, the other person's messages at the end of the selection. */
export interface ReplyTarget {
  text: string;
  /** Where it starts in the selection. */
  start: number;
  /** Earlier messages in the selection (the user's, or ones the user already answered) were left out. */
  droppedEarlier: boolean;
}

/**
 * The part of the selection to answer: the other person's messages after the user's last one
 * (decisions 47 and 48), so neither the user's messages nor ones the user already answered
 * are answered again. From the conversation read when it has messages, else the header parser,
 * where lines before the selection's first header belong to whoever spoke last before it. Null
 * when the selection ends with the user's own message.
 */
export function messagesToAnswer(text: string, before: string, me: Identity, messages?: ReadMessage[] | null): ReplyTarget | null {
  // An email chain: answer the newest message, above the quoted history (Step 21).
  const cut = quoteStart(text);
  if (cut > 0) return messagesToAnswer(text.slice(0, cut), before, me, messages?.filter((m) => m.start < cut));
  if (messages?.length) {
    let lastMine = -1;
    messages.forEach((m, i) => {
      if (m.user) lastMine = i;
    });
    const first = messages[lastMine + 1];
    if (!first) return null;
    // After one of the user's messages, the target starts at its own header; else it is the whole selection.
    const start = lastMine >= 0 ? headerStart(text, messages[lastMine]!, first) : 0;
    const target = text.slice(start).trim();
    return target ? { text: target, start, droppedEarlier: lastMine >= 0 } : null;
  }
  const known = knownName(me);
  const lines = text.split(/\r?\n/);
  const hs = headers(text, known);
  const blocks: { speaker: string | null; line: number }[] = [{ speaker: lastSpeaker(before, known), line: 0 }];
  hs.forEach((h) => blocks.push({ speaker: h.name, line: h.line }));
  const used = blocks.filter((b, i) => lines.slice(b.line, blocks[i + 1]?.line ?? lines.length).some((l) => l.trim()));
  let lastMine = -1;
  used.forEach((b, i) => {
    if (isMe(b.speaker, me)) lastMine = i;
  });
  const first = used[lastMine + 1];
  if (!first) return null;
  const start = lines.slice(0, first.line).reduce((n, l) => n + l.length + 1, 0);
  return { text: text.slice(start).trim(), start, droppedEarlier: lastMine >= 0 };
}

/** Where the target's header starts: just past the end of the user's last message's text. */
function headerStart(text: string, mine: ReadMessage, first: ReadMessage): number {
  // The user's message ends at the first header line before the target's first words.
  const between = text.slice(mine.start, first.start);
  const lines = between.split('\n');
  let cut = lines.length;
  while (cut > 1) {
    const l = lines[cut - 1]!.trim();
    if (!l || isHeaderChrome(l) || l.toLowerCase() === first.author?.trim().toLowerCase()) cut--;
    else break;
  }
  const kept = lines.slice(0, cut).join('\n').length;
  return Math.min(mine.start + kept + 1, first.start);
}

/** The thread with each of the user's own message headers marked "(the user)", so the model never answers them. */
export function markOwnHeaders(thread: string, me: Identity, alsoMine: string[] = []): string {
  const mine = new Set(alsoMine.map((n) => n.toLowerCase()));
  const known: KnownName = (n) => knownName(me)(n) || mine.has(n.toLowerCase());
  const lines = thread.split(/\r?\n/);
  for (const h of headers(thread, known)) if (known(h.name)) lines[h.line] = `${lines[h.line]}  (the user)`;
  return lines.join('\n');
}

/** Cuts `s` to its last `n` characters, starting at a line where it can. */
function lastLines(s: string, n: number): string {
  if (s.length <= n) return s;
  const cut = s.slice(-n);
  const nl = cut.indexOf('\n');
  return nl >= 0 && nl < cut.length - 1 ? cut.slice(nl + 1) : cut;
}

/** The text before and after the selection: tier 2 when it was read, else tier 1. */
function around(selection: SelectionPayload, container?: ContainerContext | null): { before: string; after: string } {
  if (container?.source === 'container' && container.text) {
    const start = Math.max(0, container.selection_start);
    return { before: container.text.slice(0, start), after: container.text.slice(start + Math.max(0, container.selection_length)) };
  }
  return { before: selection.context_before, after: selection.context_after };
}

/**
 * The text after the selection that still belongs to the selected message: up to the next
 * header. Later messages, the user's answer among them, are left out, so the model never takes
 * one for the message to answer (decision 52).
 */
function restOfMessage(after: string, me: Identity): string {
  const first = headers(after, knownName(me))[0];
  const rest = first ? after.split(/\r?\n/).slice(0, first.line).join('\n') : after;
  return rest.length > THREAD_AFTER ? `${rest.slice(0, THREAD_AFTER)}…` : rest;
}

/**
 * The thread for the prompt: about 2,000 characters before the selection, and after it only the
 * rest of the selected message (decision 52). When there's a target, the selection's earlier part
 * stays in the thread and `[REPLY TO THIS]` sits where the target is (it's quoted once, above); a
 * follow-up marks the whole selection.
 */
export function replyThread(selection: SelectionPayload, container: ContainerContext | null | undefined, target: ReplyTarget | null, me: Identity): string {
  const { before, after } = around(selection, container);
  const head = target ? `${selection.text.slice(0, target.start)}${TARGET_MARK}` : SELECTION_MARK;
  return `${lastLines(before, THREAD_BEFORE)}${head}${restOfMessage(after, me)}`;
}

const MAX_SAVED_NOTE = 400;

/**
 * "What the user has saved": people, tasks, events, and notes close to the message (decision 77),
 * private to the user. The author's own record and open tasks are already in the person section,
 * so they aren't repeated here.
 */
function savedSection(input: ReplyInput, now: Date): string[] {
  const ctx = input.context;
  if (!ctx) return [];
  const authorId = input.person?.id ?? null;
  const lines = contextLines(
    {
      people: ctx.people.filter((p) => p.id !== authorId),
      tasks: ctx.tasks.filter((c) => !(authorId && c.person_id === authorId && c.status === 'open')),
      events: ctx.events,
    },
    now,
  );
  const notes = ctx.notes.slice(0, 3).map((n) => `<note>${clip(n.text.replace(/\s+/g, ' ').trim(), MAX_SAVED_NOTE)}</note>`);
  if (!lines.length && !notes.length) return [];
  return ['', "## What the user has saved (private to the user; labels in brackets are worked out from now)", ...lines, ...(notes.length ? ['Notes:', ...notes] : [])];
}

export function buildReplyPrompt(settings: Pick<Settings, 'identity'>, input: ReplyInput, now: Date = new Date()): string {
  const { selection } = input;
  const target = input.authorIsMe ? null : messagesToAnswer(selection.text, around(selection, input.container).before, settings.identity, input.messages);
  const ownNames = (input.messages ?? []).flatMap((m) => (m.user && m.author ? [m.author] : []));
  const thread = markOwnHeaders(replyThread(selection, input.container, target, settings.identity), settings.identity, ownNames);
  const a = input.author;
  const to = input.authorIsMe
    ? 'The user wrote the selected message; draft a follow-up to the other people in the thread.'
    : a
      ? [a.name, a.email, a.handle && `@${a.handle}`].filter(Boolean).join(', ')
      : 'Unknown: whoever wrote the selected message.';
  // Stable parts first (the user, voice, preferences, notes), so Groq's prompt cache reuses them;
  // the person, then this message's parts, last (decision 48).
  const parts = ['## The user', describeIdentity(settings.identity) ?? 'Unknown.', ''];
  const voice = input.voice.slice(0, MAX_VOICE);
  parts.push('## Voice samples (how the user writes)');
  // Each sample says where it was written, so the platform's form comes from samples on it (decision 57).
  if (voice.length)
    voice.forEach((v) => {
      const s = typeof v === 'string' ? { text: v, from: null } : v;
      parts.push(s.from ? `<sample from="${PLATFORM[s.from]}">` : '<sample>', clip(s.text, MAX_VOICE_CHARS), '</sample>');
    });
  else parts.push('None yet. Keep it natural and brief.');
  if (input.preferences?.length) parts.push('', '## What the user tends to pick', ...input.preferences.map((p) => `- ${p}`));
  if (input.notes?.length) parts.push('', '## Notes on how the user writes', ...input.notes.map((n) => `- ${n}`));
  if (input.person) parts.push('', ...personSection(input.person));
  parts.push(
    '',
    '## Replying to',
    to,
    '',
    '## App',
    describeSource(selection.source_app, selection.window_title),
    ...(input.field ? ['', '## Where the user is', FIELD_NOTE] : []),
    '',
    '## Now',
    nowLine(now),
    ...savedSection(input, now),
    '',
    input.authorIsMe ? "## The user's message (write a follow-up)" : '## Their messages to answer',
    '<message>',
    clip(target?.text ?? selection.text, MAX_SELECTION),
    '</message>',
  );
  if (thread.trim() !== SELECTION_MARK) {
    const where = target ? `${TARGET_MARK} marks where their messages sit` : `${SELECTION_MARK} marks the selected message`;
    parts.push('', `## Thread (${where})`, '<thread>', thread, '</thread>');
  }
  const redo = input.redo;
  if (redo && (redo.passedOn.length || redo.asks.length || redo.note?.trim())) {
    parts.push('', '## Drafts the user passed on');
    redo.passedOn.slice(0, 3).forEach((d) => parts.push('<passed>', `${d.intent}: ${clip(d.text, 600)}`, '</passed>'));
    parts.push('', '## What the user wants instead');
    redo.asks.forEach((a) => parts.push(`- ${REDO_LINES[a]}`));
    if (redo.note?.trim()) parts.push(`- In their words: "${clip(redo.note.trim(), 300)}"`);
    if (!redo.asks.length && !redo.note?.trim()) parts.push('- Something different from these.');
  }
  return parts.join('\n');
}

/** Streams the three drafts on the Chat role, action "reply". Local only refuses in the LLM layer. */
export function reply(llm: LlmProvider, settings: Pick<Settings, 'identity'>, input: ReplyInput, signal?: AbortSignal): StreamResult {
  return llm.stream({
    role: 'chat',
    action: 'reply',
    instructions: replyPrompt,
    prompt: buildReplyPrompt(settings, input),
    signal,
    maxOutputTokens: REPLY_MAX_OUTPUT[input.channel ?? 'other'],
    reasoning: 'low',
  });
}
