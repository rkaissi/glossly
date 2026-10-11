// Reply (spec: Actions, Reply with context): three intent-labeled drafts, streamed on the Chat
// role, written with what the user knows about the person and in the user's own voice.
import replyPrompt from '../../prompts/reply.md?raw';
import type { LlmProvider, StreamResult } from '../llm/types';
import type { DetectedPerson } from '../people/detect';
import { describeIdentity } from '../people/names';
import type { ReplyRedo, ReplyRedoAsk } from '../people/reply-style';
import type { PersonCard } from '../people/types';
import type { Settings } from '../settings';
import type { ContainerContext, SelectionPayload } from '../types';
import { contextWindow } from './context';

export interface ReplyInput {
  selection: SelectionPayload;
  container?: ContainerContext | null;
  author: DetectedPerson | null;
  authorIsMe: boolean;
  /** The author's record, when they resolved exactly. */
  person: PersonCard | null;
  /** Up to 5 samples of how the user writes (pasted in Profile, then replies they edited). */
  voice: string[];
  /** What the user tends to pick here, one line each with its evidence (`preferenceLine`). */
  preferences?: string[];
  /** Style notes written from the user's edits (Profile). */
  notes?: string[];
  /** "None of these": the drafts the user passed on and what they asked for instead. */
  redo?: ReplyRedo | null;
}

const REDO_LINES: Record<ReplyRedoAsk, string> = {
  shorter: 'Shorter than these.',
  longer: 'Longer and fuller than these.',
  casual: 'More casual than these.',
  formal: 'More formal than these.',
  different: 'Different answers: do not repeat the intents of these drafts.',
};

const MAX_SELECTION = 6000;
const THREAD_CHARS = 6000;
const MAX_VOICE = 5;
const MAX_VOICE_CHARS = 600;
const SELECTION_MARK = '[SELECTION]';

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);
const day = (iso: string) => {
  const d = new Date(iso.length === 10 ? `${iso}T12:00:00` : iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
};

/** The person record for the prompt: note, open commitments both ways, and recent messages. */
function personSection(p: PersonCard): string[] {
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

export function buildReplyPrompt(settings: Pick<Settings, 'identity'>, input: ReplyInput, now: Date = new Date()): string {
  const { selection } = input;
  const win = contextWindow(selection, input.container, THREAD_CHARS);
  const thread = win.text.slice(0, win.selection_start) + SELECTION_MARK + win.text.slice(win.selection_start + win.selection_length);
  const a = input.author;
  const to = input.authorIsMe
    ? 'The user wrote the selected message; draft a follow-up to the other people in the thread.'
    : a
      ? [a.name, a.email, a.handle && `@${a.handle}`].filter(Boolean).join(', ')
      : 'Unknown: whoever wrote the selected message.';
  const parts = ['## The user', describeIdentity(settings.identity) ?? 'Unknown.', '', '## Replying to', to, ''];
  if (input.person) parts.push(...personSection(input.person), '');
  const voice = input.voice.slice(0, MAX_VOICE);
  parts.push('## Voice samples (how the user writes)');
  if (voice.length) voice.forEach((v) => parts.push('<sample>', clip(v, MAX_VOICE_CHARS), '</sample>'));
  else parts.push('None yet. Keep it natural and brief.');
  if (input.preferences?.length) parts.push('', '## What the user tends to pick', ...input.preferences.map((p) => `- ${p}`));
  if (input.notes?.length) parts.push('', '## Notes on how the user writes', ...input.notes.map((n) => `- ${n}`));
  parts.push(
    '',
    '## App',
    `${selection.source_app}${selection.window_title ? `, "${clip(selection.window_title, 200)}"` : ''}`,
    '',
    '## Today',
    now.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }),
    '',
    '## Selected message',
    '<selection>',
    clip(selection.text, MAX_SELECTION),
    '</selection>',
  );
  if (thread.trim() !== SELECTION_MARK) parts.push('', `## Thread (${SELECTION_MARK} marks the selected message)`, '<thread>', thread, '</thread>');
  const redo = input.redo;
  if (redo && (redo.passedOn.length || redo.asks.length || redo.note?.trim())) {
    parts.push('', '## Drafts the user passed on');
    redo.passedOn.slice(0, 3).forEach((d) => parts.push('<passed>', `${d.intent}: ${clip(d.text, MAX_VOICE_CHARS)}`, '</passed>'));
    parts.push('', '## What the user wants instead');
    redo.asks.forEach((a) => parts.push(`- ${REDO_LINES[a]}`));
    if (redo.note?.trim()) parts.push(`- In their words: "${clip(redo.note.trim(), 300)}"`);
    if (!redo.asks.length && !redo.note?.trim()) parts.push('- Something different from these.');
  }
  return parts.join('\n');
}

/** Streams the three drafts on the Chat role, action "reply". Local only refuses in the LLM layer. */
export function reply(llm: LlmProvider, settings: Pick<Settings, 'identity'>, input: ReplyInput, signal?: AbortSignal): StreamResult {
  return llm.stream({ role: 'chat', action: 'reply', instructions: replyPrompt, prompt: buildReplyPrompt(settings, input), signal, maxOutputTokens: 1200 });
}
