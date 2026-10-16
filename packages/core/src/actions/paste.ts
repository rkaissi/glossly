// Paste for the bar with nothing selected. It picks the saved snippets that fit what the user is
// writing (by meaning, against the text around the caret), else the most recent ones, and
// formats them for where the cursor is: an email, a chat, a document, code. Two forms: a list,
// made in code, and a text written for that spot by the Chat model (one structured call). Either
// way the text is shown first and pasted only when the user says so.
import { z } from 'zod';
import pastePrompt from '../../prompts/paste-compose.md?raw';
import { cleanText } from '../capture/clean';
import type { Embedder } from '../embed/types';
import type { LlmProvider } from '../llm/types';
import { describeSource, replyChannel } from '../people/reply-style';
import type { Settings } from '../settings';
import type { Store } from '../store/store';
import { isoNow, type Item, type Surroundings } from '../types';
import { markCursor } from './ask';
import { PASTE_FORMATS, type PasteFormat, type PasteTarget } from './paste-types';

export { PASTE_FORMATS, type PasteFormat, type PasteTarget } from './paste-types';

const MAX_LIST_ITEM = 300;
const MAX_PROMPT_ITEM = 1200;
const MAX_SURROUNDINGS = 3000;
const DAY_MS = 86_400_000;
/** Too little text around the caret to say what fits; use the recent snippets. */
const MIN_CONTEXT_CHARS = 20;

const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);


const DOC_PROCESSES = ['winword.exe', 'notepad.exe', 'wordpad.exe', 'onenote.exe', 'onenoteim.exe', 'notion.exe', 'obsidian.exe', 'soffice.bin', 'evernote.exe', 'typora.exe'];
const CODE_PROCESSES = ['code.exe', 'cursor.exe', 'devenv.exe', 'idea64.exe', 'pycharm64.exe', 'webstorm64.exe', 'rider64.exe', 'sublime_text.exe', 'notepad++.exe', 'zed.exe'];
const DOC_TITLES = /(?:- Google Docs|- Word\b|Notion\b|- OneNote|Confluence|Dropbox Paper|Coda\b|- Obsidian|Quip\b)/i;
const CODE_TITLES = /(?:- Visual Studio Code|- Cursor$|· GitHub|- GitHub)/i;

export function pasteTarget(app: string, title: string): PasteTarget {
  const channel = replyChannel(app, title);
  if (channel === 'email') return 'email';
  if (channel === 'messaging' || channel === 'work_chat') return 'chat';
  const p = app.toLowerCase();
  if (CODE_PROCESSES.includes(p) || CODE_TITLES.test(title)) return 'code';
  if (DOC_PROCESSES.includes(p) || DOC_TITLES.test(title)) return 'document';
  return 'other';
}

/** How many snippets fit each kind of place: a chat message stays short, a document can take more. */
export const PASTE_COUNT: Record<PasteTarget, number> = { chat: 3, email: 5, code: 5, other: 5, document: 8 };

/** Saved items from the last `paste.recentDays` days, newest first, at most `paste.recentCount`. */
export function recentSnippets(store: Store, settings: Pick<Settings, 'paste'>, now = Date.now()): Item[] {
  // Same format as created_at (local offset), so the string comparison in SQL holds.
  const since = isoNow(new Date(now - settings.paste.recentDays * DAY_MS));
  return store.itemsWithCollection(store.recentItemIds(settings.paste.recentCount, since));
}

export interface PasteDeps {
  store: Store;
  /** Null until the local model is loaded; paste then uses the recent snippets. */
  embedder: () => Embedder | null;
  settings: () => Pick<Settings, 'paste'>;
}

export interface PasteSnippets {
  /** In the order to paste them: by relevance when related, oldest first when recent. */
  items: Item[];
  /** `related`: chosen by meaning against the surroundings; `recent`: the newest ones. */
  reason: 'related' | 'recent';
}

/** The text the snippets are matched against: what is just before the caret, or what is on screen. */
function queryText(s: Surroundings): string {
  if (s.caret < 0) return s.text.slice(0, 2000);
  return s.text.slice(Math.max(0, s.caret - 1500), s.caret + 500);
}

/** Leaves out a snippet that is already in the text (it was pasted here before). */
const alreadyThere = (it: Item, around: string) => {
  const head = oneLine(cleanText(it.text)).slice(0, 80).toLowerCase();
  return head.length >= 20 && oneLine(around).toLowerCase().includes(head);
};

/**
 * The snippets for this spot. With surroundings and the embedding model: saved items close in
 * meaning to what the user is writing (any age; a newer one wins a near tie), at most
 * PASTE_COUNT for the target. Otherwise, or when nothing is close: the most recent ones.
 */
export async function pasteSnippets(deps: PasteDeps, input: { surroundings: Surroundings | null; target: PasteTarget }, now = Date.now()): Promise<PasteSnippets> {
  const settings = deps.settings();
  const n = Math.min(PASTE_COUNT[input.target], settings.paste.recentCount);
  const around = input.surroundings?.text ?? '';
  const embedder = deps.embedder();
  if (around.trim().length >= MIN_CONTEXT_CHARS && embedder && deps.store.hasVectors) {
    const [v] = await embedder.embed([queryText(input.surroundings!)]);
    const hits = v ? deps.store.searchVectors(v, n * 4).filter((r) => r.similarity >= settings.paste.relatedSimilarity) : [];
    if (hits.length) {
      const sims = new Map(hits.map((h) => [h.item_id, h.similarity]));
      const fresh = (it: Item) => {
        const age = (now - new Date(it.created_at).getTime()) / DAY_MS;
        return Number.isFinite(age) ? 0.05 * Math.exp(-Math.max(0, age) / settings.paste.recentDays) : 0;
      };
      const items = deps.store
        .itemsWithCollection(hits.map((h) => h.item_id))
        .filter((it) => !alreadyThere(it, around))
        .sort((a, b) => sims.get(b.id)! + fresh(b) - (sims.get(a.id)! + fresh(a)))
        .slice(0, n);
      if (items.length) return { items, reason: 'related' };
    }
  }
  const recent = recentSnippets(deps.store, settings, now)
    .filter((it) => !alreadyThere(it, around))
    .slice(0, n)
    .reverse();
  return { items: recent, reason: 'recent' };
}

const RICH_PROCESSES = ['winword.exe', 'wordpad.exe', 'onenote.exe', 'onenoteim.exe', 'notion.exe', 'evernote.exe', 'soffice.bin'];
const RICH_TITLES = /(?:- Google Docs|- Word\b|Notion\b|- OneNote|Confluence|Dropbox Paper|Coda\b|Quip\b)/i;

/**
 * A rich-text editor (Docs, Word, OneNote, Notion…): each pasted line takes the formatting of
 * the paragraph at the caret, so inside a bulleted list every line becomes a bullet on its own,
 * and a typed "- " would show as "• - …".
 */
export function richEditor(app: string, title: string): boolean {
  return RICH_PROCESSES.includes(app.toLowerCase()) || RICH_TITLES.test(title);
}

/**
 * The snippets as a list for the target: plain lines in a chat and in a rich-text editor (which
 * keeps its own bullets), "- " bullets elsewhere. Keeps the given order.
 */
export function pasteList(items: Pick<Item, 'text'>[], target: PasteTarget = 'other', rich = false): string {
  const lines = items.map((it) => clip(oneLine(cleanText(it.text)), MAX_LIST_ITEM));
  return target === 'chat' || rich ? lines.join('\n') : lines.map((l) => `- ${l}`).join('\n');
}

/** The snippets as they were saved (cleaned of capture artifacts), in the given order, a blank line between them. */
export function pasteAsSaved(items: Pick<Item, 'text'>[]): string {
  return items.map((it) => cleanText(it.text)).join('\n\n');
}


export const PasteDraftSchema = z.object({
  use: z.array(z.number().int()).describe('The n of every snippet the text uses. Empty when none fits.'),
  format: z.enum(PASTE_FORMATS),
  text: z.string().describe('The text to insert at the cursor, ready to paste. Empty when no snippet fits.'),
});

const TARGET_WORDS: Record<PasteTarget, string> = {
  email: 'an email',
  chat: 'a chat message',
  document: 'a document',
  code: 'a code editor',
  other: 'an app (kind unknown)',
};

export interface PasteComposeInput {
  items: Pick<Item, 'text' | 'why' | 'created_at'>[];
  target: PasteTarget;
  app: string;
  title: string;
  surroundings: Surroundings | null;
}

export function buildPastePrompt(input: PasteComposeInput): string {
  const parts = [
    '## Where the text goes',
    `${TARGET_WORDS[input.target]}: ${describeSource(input.app, input.title)}`,
    '',
  ];
  const s = input.surroundings;
  if (s?.text.trim()) {
    const marked = markCursor(s);
    const at = s.caret >= 0 ? s.caret : 0;
    // Keep the cursor inside the window when the text is long.
    const start = Math.max(0, Math.min(at - Math.floor(MAX_SURROUNDINGS * 0.7), marked.length - MAX_SURROUNDINGS));
    parts.push(
      s.source === 'caret' ? '## What the user is writing ([CURSOR] marks where the text goes)' : '## What is on the screen (no cursor found)',
      '<context>',
      marked.slice(start, start + MAX_SURROUNDINGS),
      '</context>',
      '',
    );
  } else {
    parts.push('## What the user is writing', 'Unknown.', '');
  }
  parts.push('## Saved snippets');
  input.items.forEach((it, i) => {
    parts.push(`<snippet n="${i + 1}" saved="${it.created_at.slice(0, 10)}">`, clip(cleanText(it.text), MAX_PROMPT_ITEM));
    if (it.why) parts.push(`Why it was saved: ${clip(oneLine(it.why), 200)}`);
    parts.push('</snippet>');
  });
  return parts.join('\n');
}

export interface PasteDraft {
  text: string;
  format: PasteFormat;
  /** Indexes into the input items that the text uses. */
  used: number[];
}

/** The text for this spot, on the Chat role. Empty text means no snippet fits. Throws LlmError. */
export async function composePaste(llm: LlmProvider, input: PasteComposeInput, signal?: AbortSignal): Promise<PasteDraft> {
  const out = await llm.structured(
    { role: 'chat', action: 'paste_summary', instructions: pastePrompt, prompt: buildPastePrompt(input), signal, maxOutputTokens: 900, temperature: 0.2 },
    PasteDraftSchema,
  );
  const used = [...new Set(out.use.filter((n) => Number.isInteger(n) && n >= 1 && n <= input.items.length).map((n) => n - 1))];
  return { text: out.text.trim(), format: out.format, used };
}
