import { tool } from 'ai';
import { z } from 'zod';
import askPrompt from '../../prompts/ask.md?raw';
import { askTools, type AskToolDeps } from './ask-tools';
import { contextLines, nowLine } from '../context/prompt';
import type { RetrievedContext } from '../context/retrieve';
import type { LlmProvider, StreamResult } from '../llm/types';
import { describeIdentity } from '../people/names';
import { describeSource } from '../people/reply-style';
import type { Settings } from '../settings';
import type { ContainerContext, Item, SelectionPayload, Surroundings } from '../types';
import { contextWindow } from './context';

export interface AskInput {
  selection: SelectionPayload;
  /** Tier-2 context, when it was read. Falls back to tier 1. */
  container?: ContainerContext | null;
  /** For the prompt's date; now when left out. */
  now?: Date;
  /** Empty or missing means settings.ask.defaultQuestion. */
  question?: string;
  /** Saved notes: the retriever's, or the cards picked with "Ask about these". */
  related?: Pick<Item, 'text' | 'why' | 'created_at'>[];
  /** Saved people, tasks, and events close to the question (decision 77). */
  context?: Pick<RetrievedContext, 'people' | 'tasks' | 'events'> | null;
  /** Lets Ask save a note when the question asks it to remember something. */
  remember?: RememberDeps;
  /** Lets Ask add tasks and events, edit saved people, and note facts about the user (decision 78). */
  tools?: AskToolDeps;
  /** Nothing selected: the text around the caret, or what is on screen. */
  surroundings?: Surroundings | null;
}

export interface RememberDeps {
  /** The user's collections; the model picks one. */
  collections: string[];
  /** The collection the router picked for this selection, offered as the default. */
  suggested: string;
  /** Saves the memory, or rewords a close one (decision 78), and says where it went. */
  save: (note: string, collection: string, asked: boolean) => Promise<{ collection: string; updated: boolean }> | { collection: string; updated: boolean };
}

const MAX_NOTE = 1000;

interface RememberInput {
  note: string;
  collection: string;
  asked: boolean;
}

/**
 * The `remember` tool on the Ask stream (decisions 24 and 78): saves a memory into a collection,
 * when asked or when the conversation shows something worth keeping. Asked, it reports the save
 * in the answer ("Saved to Notes: ...") and the stream ends there; unasked, it says nothing (the
 * panel shows it with Undo) and the model goes on to answer if it hadn't (`continueAfterTools`).
 */
export function rememberTool(deps: RememberDeps) {
  const names = deps.collections.length ? deps.collections : [deps.suggested];
  return tool({
    description:
      `Save a memory for the person: when they ask you to remember, save, keep, or note something, and also on your own when the conversation shows something worth knowing later ` +
      `(a fact about them or someone they know, a preference, a plan with a date). Not for passing details, things only true right now, or secrets such as passwords or card or ID numbers. Collections: ${names.join(', ')}.`,
    inputSchema: z.object({
      note: z.string().describe('What to remember: short and self-contained, with the full names and dates it needs.'),
      collection: z.string().describe(`One of: ${names.join(', ')}. Use ${deps.suggested} when unsure.`),
      asked: z.boolean().describe('True when the person asked you to remember this; false when you chose to.'),
    }),
    execute: async ({ note, collection, asked }: RememberInput) => {
      const text = note.replace(/\s+/g, ' ').trim().slice(0, MAX_NOTE);
      if (!text) return { say: asked ? 'There was nothing to save.' : '' };
      const known = names.find((n) => n.toLowerCase() === collection.trim().toLowerCase()) ?? deps.suggested;
      const saved = await deps.save(text, known, asked !== false);
      if (asked === false) return { say: '' };
      return { say: `${saved.updated ? 'Updated in' : 'Saved to'} ${saved.collection}: "${clip(text, 160)}"` };
    },
  });
}

/** After a tools step: write the answer when the only saves were unasked ones and nothing was said yet. */
export function answerAfterUnaskedSave(step: { text: string; toolInputs: unknown[] }): boolean {
  if (step.text.trim()) return false;
  return step.toolInputs.length > 0 && step.toolInputs.every((i) => (i as Partial<RememberInput> | null)?.asked === false);
}

const MAX_SELECTION = 12_000;
const MAX_NOTES = 3;
const MAX_NOTE_CHARS = 800;
const SELECTION_MARK = '[SELECTION]';
const CURSOR_MARK = '[CURSOR]';

/** The surroundings with a cursor mark where the caret is (none for visible text). */
export function markCursor(s: Surroundings): string {
  return s.caret >= 0 ? s.text.slice(0, s.caret) + CURSOR_MARK + s.text.slice(s.caret) : s.text;
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

/** "From your note, Sep 18": how Ask labels a saved item so the answer can cite it. */
export function noteLabel(item: Pick<Item, 'created_at'>): string {
  const d = new Date(item.created_at);
  const date = Number.isNaN(d.getTime()) ? 'undated' : new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' }).format(d);
  return `From your note, ${date}`;
}

/** Labels for the saved notes, made unique when two share a date. */
export function noteLabels(items: Pick<Item, 'created_at'>[]): string[] {
  const seen = new Map<string, number>();
  return items.map((it) => {
    const base = noteLabel(it);
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return n === 1 ? base : `${base} (${n})`;
  });
}

type AskSettings = Pick<Settings, 'ask' | 'capture' | 'identity'> & Partial<Pick<Settings, 'aboutMe'>>;

/** Facts about the user Ask always gets (decision 78): the newest that fit. */
const MAX_ABOUT_ME = 20;
const MAX_ABOUT_ME_CHARS = 1500;

function aboutMeLines(list: Settings['aboutMe'] | undefined): string[] {
  const out: string[] = [];
  let used = 0;
  for (const f of [...(list ?? [])].reverse()) {
    if (out.length >= MAX_ABOUT_ME || used + f.text.length > MAX_ABOUT_ME_CHARS) break;
    out.unshift(`- ${f.text}`);
    used += f.text.length;
  }
  return out;
}

export function buildAskPrompt(settings: AskSettings, input: AskInput): { question: string; prompt: string } {
  const question = input.question?.trim() || settings.ask.defaultQuestion;
  const { selection } = input;
  const win = contextWindow(selection, input.container, settings.capture.containerChars);
  const surrounding =
    win.text.slice(0, win.selection_start) + SELECTION_MARK + win.text.slice(win.selection_start + win.selection_length);

  const me = describeIdentity(settings.identity);
  const now = input.now ?? new Date();
  const parts = [
    '## Question',
    question,
    '',
    // Without this the model reads a message in the selection as the asker's own.
    '## The person asking',
    me ? `${me}. They are reading the selection; they did not write it unless it is signed by or attributed to them.` : 'Unknown. They are reading the selection and most likely did not write it.',
    ...(() => {
      const facts = aboutMeLines(settings.aboutMe);
      return facts.length ? ['What you know about them:', ...facts] : [];
    })(),
    '',
    // For "when is that?" and "how long ago" (decision 54); with the time, so "in 3 hours" and "past" in the saved data read right (decision 77).
    '## Now',
    nowLine(now),
    '',
  ];
  const where = describeSource(selection.source_app, selection.window_title);
  const around = input.surroundings;
  if (!selection.text.trim()) {
    // Nothing selected: the question is about what is on screen, or a general one.
    parts.push(`## Nothing is selected (the person is in ${where || 'an unknown app'})`);
    if (around?.text.trim()) {
      parts.push(
        '',
        around.source === 'caret' ? `## Around their cursor (${CURSOR_MARK} marks where they are typing)` : '## What is on their screen',
        '<context>',
        markCursor(around),
        '</context>',
      );
    }
  } else {
    parts.push(`## Selection (from ${where})`, '<selection>', clip(selection.text, MAX_SELECTION), '</selection>');
  }
  if (selection.text.trim() && surrounding.trim() !== SELECTION_MARK) {
    parts.push(
      '',
      `## Surrounding context (${SELECTION_MARK} marks where the selection is)`,
      '<context>',
      surrounding,
      '</context>',
    );
  }
  const saved = input.context ? contextLines(input.context, now) : [];
  if (saved.length > 0) {
    parts.push('', '## Their saved people, tasks, and calendar (labels in brackets are worked out from now)', ...saved);
  }
  const notes = (input.related ?? []).slice(0, MAX_NOTES);
  if (notes.length > 0) {
    const labels = noteLabels(notes);
    parts.push('', '## Saved notes');
    notes.forEach((n, i) => {
      parts.push(`<note label="${labels[i]}">`, clip(n.text, MAX_NOTE_CHARS));
      if (n.why) parts.push(`Why it was saved: ${clip(n.why, 200)}`);
      parts.push('</note>');
    });
  }
  return { question, prompt: parts.join('\n') };
}

/** Streams an answer to a question about the selection, on the Chat role. */
export function ask(llm: LlmProvider, settings: AskSettings, input: AskInput, signal?: AbortSignal): StreamResult {
  const { prompt } = buildAskPrompt(settings, input);
  const tools = input.remember || input.tools ? { ...(input.remember && { remember: rememberTool(input.remember) }), ...(input.tools && askTools(input.tools)) } : undefined;
  return llm.stream({ role: 'chat', action: 'ask', instructions: askPrompt, prompt, signal, maxOutputTokens: 800, ...(tools && { tools, continueAfterTools: answerAfterUnaskedSave }) });
}
