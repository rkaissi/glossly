// Reply with nothing selected (decision 75): the hotkey in a reply box, an email's reply field,
// or a comment box. The surroundings tell whether the field answers someone, and what to answer.
import { z } from 'zod';
import fieldPrompt from '../../prompts/router-field.md?raw';
import { countWords } from '../capture/gating';
import type { LlmProvider } from '../llm/types';
import { QUOTE_HEADER } from '../people/conversation';
import { describeSource, replyChannel } from '../people/reply-style';
import type { Identity } from '../settings';
import type { Surroundings } from '../types';
import { extractFeatures, type Features } from './features';
import type { KnownPerson } from './types';

/** What the hotkey read with nothing selected. */
export interface FieldInput {
  surroundings: Surroundings | null;
  /** Whether the focused control takes text; null when the helper couldn't tell. */
  editable: boolean | null;
  source_app: string;
  window_title: string;
}

/** The messages a reply box sits under: `text` is what to answer, `before` the thread above it. */
export interface FieldThread {
  text: string;
  before: string;
}

/** The text before the caret needs this many words to hold a message worth answering. */
const MIN_WORDS = 8;
/** About the size of a highlighted message and its tier-1 context (decision 48). */
const MESSAGE_CHARS = 2500;
const BEFORE_CHARS = 2000;
/** The most a model score with nothing in the text or app to back it can be (as decision 51). */
const UNBACKED = 0.45;
/** Titles of a reply, a thread, or a comment page ("Re: Lunch", "Reply to Alex", "Inbox (3)"). */
const TITLE_REPLY = /(?:^|[\s|(\-–—])(?:re|fwd?|aw|sv):|\b(?:reply|replying|respond|comments?|thread|conversation|inbox|direct messages?|dms?|chat)\b/i;
/** An email's header lines above its body. */
const EMAIL_HEAD = /^(?:from|to|cc|subject|sent|date):\s*\S/im;
const SECOND_PERSON = /\b(?:you|your|you're|u)\b/i;

/** Cuts `s` to its last `n` characters, starting at a line where it can. */
function lastLines(s: string, n: number): string {
  if (s.length <= n) return s;
  const cut = s.slice(-n);
  const nl = cut.indexOf('\n');
  return nl >= 0 && nl < cut.length - 1 ? cut.slice(nl + 1) : cut;
}

/**
 * The messages around the caret to answer. Most reply boxes sit under the thread (chat composers,
 * Gmail), so it's the text before the caret; Outlook writes above the quoted message, so with
 * little before it, a quoted header after the caret marks the message instead. Null when the
 * caret isn't in a field or nothing around it reads like something to answer.
 */
export function fieldThread(sur: Surroundings | null): FieldThread | null {
  if (!sur || sur.source !== 'caret') return null;
  const caret = sur.caret >= 0 ? Math.min(sur.caret, sur.text.length) : sur.text.length;
  const before = sur.text.slice(0, caret);
  if (countWords(before) >= MIN_WORDS) {
    const text = lastLines(before, MESSAGE_CHARS);
    return { text: text.trim(), before: lastLines(before.slice(0, before.length - text.length), BEFORE_CHARS) };
  }
  const after = sur.text.slice(caret);
  const quote = QUOTE_HEADER.exec(after);
  if (!quote) return null;
  const text = after.slice(quote.index, quote.index + MESSAGE_CHARS).trim();
  return countWords(text) >= MIN_WORDS ? { text, before: '' } : null;
}

/** What the rules know about the field: its thread's features and what backs it being a reply box. */
export interface FieldRead {
  thread: FieldThread;
  features: Features;
  /** 0 to 1: the rules' score that the field answers someone. */
  rules: number;
  /** Something in the app, title, or text says it's a conversation, so a model score counts in full. */
  backed: boolean;
  /** Nobody to answer: automated mail, the user's own last message, a code editor, or a field that takes no text. */
  blocked: boolean;
}

/**
 * The rules' read of the field: an email or chat app, a conversation's shape in the text (chat
 * headers, a quoted email, header lines), and a reply-like title each add to the score; a message
 * to the user ("you", a question) a little more. Null when there is no thread to answer.
 */
export function readField(input: FieldInput, people: KnownPerson[] = [], me?: Identity): FieldRead | null {
  const thread = input.editable === false ? null : fieldThread(input.surroundings);
  if (!thread) return null;
  const features = extractFeatures(
    { text: thread.text, context_before: thread.before, context_after: '', source_app: input.source_app, window_title: input.window_title, is_editable: false },
    people,
    me,
  );
  const app = features.messengerApp || replyChannel(input.source_app, input.window_title) !== 'other';
  const shape = features.chatLines >= 1 || QUOTE_HEADER.test(thread.text) || EMAIL_HEAD.test(thread.text);
  const title = TITLE_REPLY.test(input.window_title);
  const toUser = features.endsWithQuestion || SECOND_PERSON.test(thread.text);
  const blocked = features.automated || features.authorIsMe || features.codeEditorApp;
  const rules = blocked ? 0 : Math.min(0.95, (app ? 0.55 : 0) + (shape ? 0.25 : 0) + (title ? 0.2 : 0) + (toUser ? 0.1 : 0));
  return { thread, features, rules, backed: app || shape || title, blocked };
}

/**
 * The Reply score for the empty bar: the model's answer when there is one, else the rules'. As
 * with a selection, the model can't recommend Reply where there's nobody to answer, and counts in
 * full only with something to back it (decision 51).
 */
export function fieldReplyScore(read: FieldRead | null, model: number | null): number {
  if (!read || read.blocked) return 0;
  if (model === null) return read.rules;
  return read.backed ? model : Math.min(model, UNBACKED);
}

const FieldSchema = z.object({ reply_box: z.number().min(0).max(1) });

export function formatFieldPrompt(input: FieldInput): string {
  const sur = input.surroundings ?? { text: '', caret: 0, source: 'caret' as const };
  const caret = sur.caret >= 0 ? Math.min(sur.caret, sur.text.length) : sur.text.length;
  return [
    `App: ${describeSource(input.source_app, input.window_title)}`,
    '',
    '<before_caret>',
    lastLines(sur.text.slice(0, caret), 1500),
    '</before_caret>',
    '<after_caret>',
    sur.text.slice(caret, caret + 500),
    '</after_caret>',
  ].join('\n');
}

/** The model's read of the field, on the Decision role like the router (action "router"). */
export async function decideField(llm: LlmProvider, input: FieldInput, signal?: AbortSignal, onFallback?: () => void): Promise<number> {
  const out = await llm.structured(
    {
      role: 'decision',
      action: 'router',
      instructions: fieldPrompt,
      prompt: formatFieldPrompt(input),
      signal,
      temperature: 0,
      maxOutputTokens: 60,
      ...(onFallback && { onFallback: () => onFallback() }),
    },
    FieldSchema,
  );
  return out.reply_box;
}
