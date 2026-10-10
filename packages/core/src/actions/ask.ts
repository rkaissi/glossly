import askPrompt from '../../prompts/ask.md?raw';
import type { LlmProvider, StreamResult } from '../llm/types';
import type { Settings } from '../settings';
import type { ContainerContext, Item, SelectionPayload } from '../types';
import { contextWindow } from './context';

export interface AskInput {
  selection: SelectionPayload;
  /** Tier-2 context, when it was read. Falls back to tier 1. */
  container?: ContainerContext | null;
  /** Empty or missing means settings.ask.defaultQuestion. */
  question?: string;
  /** Top recall results. Phase 1 passes []. */
  related?: Item[];
}

const MAX_SELECTION = 12_000;
const MAX_NOTES = 3;
const MAX_NOTE_CHARS = 800;
const SELECTION_MARK = '[SELECTION]';

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

export function buildAskPrompt(settings: Pick<Settings, 'ask' | 'capture'>, input: AskInput): { question: string; prompt: string } {
  const question = input.question?.trim() || settings.ask.defaultQuestion;
  const { selection } = input;
  const win = contextWindow(selection, input.container, settings.capture.containerChars);
  const surrounding =
    win.text.slice(0, win.selection_start) + SELECTION_MARK + win.text.slice(win.selection_start + win.selection_length);

  const parts = [
    '## Question',
    question,
    '',
    `## Selection (from ${selection.source_app}${selection.window_title ? `, "${clip(selection.window_title, 200)}"` : ''})`,
    '<selection>',
    clip(selection.text, MAX_SELECTION),
    '</selection>',
  ];
  if (surrounding.trim() !== SELECTION_MARK) {
    parts.push(
      '',
      `## Surrounding context (${SELECTION_MARK} marks where the selection is)`,
      '<context>',
      surrounding,
      '</context>',
    );
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
export function ask(llm: LlmProvider, settings: Pick<Settings, 'ask' | 'capture'>, input: AskInput, signal?: AbortSignal): StreamResult {
  const { prompt } = buildAskPrompt(settings, input);
  return llm.stream({ role: 'chat', action: 'ask', instructions: askPrompt, prompt, signal, maxOutputTokens: 800 });
}
