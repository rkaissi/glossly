// Paste for the bar with nothing selected: the user's recent snippets as a plain list, or as a
// short summary written by the Chat model. Either way the text is shown first and pasted only
// when the user says so.
import pastePrompt from '../../prompts/paste-summary.md?raw';
import type { LlmProvider } from '../llm/types';
import type { Settings } from '../settings';
import type { Store } from '../store/store';
import { isoNow, type Item } from '../types';

const MAX_LIST_ITEM = 300;
const MAX_PROMPT_ITEM = 1200;
const DAY_MS = 86_400_000;

const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Saved items from the last `paste.recentDays` days, newest first, at most `paste.recentCount`. */
export function recentSnippets(store: Store, settings: Pick<Settings, 'paste'>, now = Date.now()): Item[] {
  // Same format as created_at (local offset), so the string comparison in SQL holds.
  const since = isoNow(new Date(now - settings.paste.recentDays * DAY_MS));
  return store.itemsWithCollection(store.recentItemIds(settings.paste.recentCount, since));
}

/** One "- " line per snippet, oldest first so the list reads in the order things were saved. */
export function pasteList(items: Pick<Item, 'text'>[]): string {
  return [...items]
    .reverse()
    .map((it) => `- ${clip(oneLine(it.text), MAX_LIST_ITEM)}`)
    .join('\n');
}

export function buildPasteSummaryPrompt(items: Pick<Item, 'text' | 'why' | 'created_at'>[]): string {
  const parts = ['## Recently saved snippets (oldest first)'];
  [...items].reverse().forEach((it, i) => {
    parts.push(`<snippet n="${i + 1}" saved="${it.created_at.slice(0, 10)}">`, clip(it.text.trim(), MAX_PROMPT_ITEM));
    if (it.why) parts.push(`Why it was saved: ${clip(oneLine(it.why), 200)}`);
    parts.push('</snippet>');
  });
  return parts.join('\n');
}

/** The summary, on the Chat role. Throws LlmError (local_only, no_model, provider, ...). */
export async function pasteSummary(llm: LlmProvider, items: Item[], signal?: AbortSignal): Promise<string> {
  const r = llm.stream({ role: 'chat', action: 'paste_summary', instructions: pastePrompt, prompt: buildPasteSummaryPrompt(items), signal, maxOutputTokens: 500, temperature: 0.2 });
  let text = '';
  for await (const chunk of r.textStream) text += chunk;
  return text.trim();
}
