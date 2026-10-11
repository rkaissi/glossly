import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import type { Embedder } from '../embed/types';
import type { ChatRequest, LlmProvider } from '../llm/types';
import { DEFAULT_SETTINGS } from '../settings';
import { assignEmptySlots, scoreEmptyActions } from '../router/slots';
import { Store } from '../store/store';
import { buildPastePrompt, composePaste, pasteAsSaved, pasteList, pasteSnippets, pasteTarget, recentSnippets } from './paste';

const require = createRequire(import.meta.url);
const vecExtensionPath = (require('sqlite-vec') as { getLoadablePath(): string }).getLoadablePath();

const NOW = Date.UTC(2026, 9, 10, 12);
const at = (daysAgo: number) => new Date(NOW - daysAgo * 86_400_000).toISOString().replace('Z', '+00:00');

/** One axis per topic word, like the recall tests. */
const TOPICS = ['budget', 'launch', 'recipe'];
const embedder: Embedder = {
  model: 'fake',
  dims: 4,
  async embed(texts) {
    return texts.map((t) => {
      const v = new Float32Array(4);
      TOPICS.forEach((w, i) => {
        if (t.toLowerCase().includes(w)) v[i] = 1;
      });
      if (!v.some(Boolean)) v[3] = 1;
      const n = Math.hypot(...v);
      return v.map((x) => x / n);
    });
  },
};

function setup() {
  const store = new Store(':memory:', { vecExtensionPath });
  store.ensureVectorModel('fake', 4);
  const notes = store.collectionByName('Notes')!;
  const put = (text: string, daysAgo: number) =>
    store.insertItem({ collection_id: notes.id, kind: 'selection', text, why: null, source_app: null, window_title: null, data_json: null, created_at: at(daysAgo) });
  const add = async (text: string, daysAgo: number) => {
    const it = put(text, daysAgo);
    store.setVector(it.id, (await embedder.embed([text]))[0]!);
    return it;
  };
  return { store, put, add };
}

describe('paste', () => {
  it('lists recent snippets newest first, and formats them in the order given', () => {
    const { store, put } = setup();
    try {
      put('Too old', 9);
      put('The launch moved\nto Thursday', 2);
      put('Budget is 40k', 1);
      const items = recentSnippets(store, DEFAULT_SETTINGS, NOW);
      expect(items.map((i) => i.text)).toEqual(['Budget is 40k', 'The launch moved\nto Thursday']);
      const ordered = [...items].reverse();
      expect(pasteList(ordered)).toBe('- The launch moved to Thursday\n- Budget is 40k');
      expect(pasteList(ordered, 'chat')).toBe('The launch moved to Thursday\nBudget is 40k');
      expect(pasteAsSaved(ordered)).toBe('The launch moved\nto Thursday\n\nBudget is 40k');
    } finally {
      store.close();
    }
  });

  it('knows where the cursor is: email, chat, document, code', () => {
    expect(pasteTarget('chrome.exe', 'Inbox - alex.morgan@example.com - Gmail')).toBe('email');
    expect(pasteTarget('slack.exe', 'design')).toBe('chat');
    expect(pasteTarget('chrome.exe', 'Plan - Google Docs - Google Chrome')).toBe('document');
    expect(pasteTarget('notepad.exe', 'notes.txt')).toBe('document');
    expect(pasteTarget('code.exe', 'app.ts - glossly - Visual Studio Code')).toBe('code');
    expect(pasteTarget('explorer.exe', 'Downloads')).toBe('other');
  });

  it('picks the snippets that fit the text around the cursor, of any age, else the newest', async () => {
    const { store, add } = setup();
    try {
      const old = await add('Q4 budget is 40k for the offsite', 30);
      await add('Soup recipe with leeks', 1);
      await add('Launch checklist', 2);
      const deps = { store, embedder: () => embedder, settings: () => DEFAULT_SETTINGS };
      const writing = { text: 'Hi Sam, about the budget: ', caret: 26, source: 'caret' as const };
      const related = await pasteSnippets(deps, { surroundings: writing, target: 'email' }, NOW);
      expect(related.reason).toBe('related');
      expect(related.items.map((i) => i.id)).toEqual([old.id]);

      const none = await pasteSnippets(deps, { surroundings: null, target: 'chat' }, NOW);
      expect(none.reason).toBe('recent');
      expect(none.items.map((i) => i.text)).toEqual(['Launch checklist', 'Soup recipe with leeks']);

      // A snippet already in the text is not offered again.
      const pasted = { text: 'Notes so far:\nQ4 budget is 40k for the offsite\n', caret: 45, source: 'caret' as const };
      expect((await pasteSnippets(deps, { surroundings: pasted, target: 'document' }, NOW)).items.map((i) => i.id)).not.toContain(old.id);
    } finally {
      store.close();
    }
  });

  it('asks the Chat role for text shaped for the spot, and keeps only real snippet numbers', async () => {
    const calls: ChatRequest[] = [];
    const llm: LlmProvider = {
      stream: () => {
        throw new Error('unused');
      },
      structured: async <T,>(req: ChatRequest) => {
        calls.push(req);
        return { use: [2, 2, 7], format: 'sentences', text: '  The budget is 40k.  ' } as T;
      },
      hasModel: () => true,
    };
    const items = [
      { text: 'Launch checklist', why: null, created_at: '2026-10-08T10:00:00-04:00' },
      { text: 'Q4 budget is 40k', why: 'for Sam', created_at: '2026-10-09T10:00:00-04:00' },
    ];
    const input = {
      items,
      target: 'email' as const,
      app: 'chrome.exe',
      title: 'Re: offsite - Gmail',
      surroundings: { text: 'Hi Sam,\n\n', caret: 9, source: 'caret' as const },
    };
    const p = buildPastePrompt(input);
    expect(p).toContain('an email: chrome.exe, "Re: offsite - Gmail"');
    expect(p).toContain('Hi Sam,\n\n[CURSOR]');
    expect(p).toContain('<snippet n="2" saved="2026-10-09">\nQ4 budget is 40k\nWhy it was saved: for Sam');
    const draft = await composePaste(llm, input);
    expect(draft).toEqual({ text: 'The budget is 40k.', format: 'sentences', used: [1] });
    expect(calls[0]).toMatchObject({ role: 'chat', action: 'paste_summary' });
  });

  it('ranks Search first, then pasting, under the shared slot rule', () => {
    const router = DEFAULT_SETTINGS.router;
    const full = assignEmptySlots({ editable: true, recent: 3, summaryModel: true }, router);
    expect([full.slot3?.action, full.slot4?.action]).toEqual(['search', 'paste_list']);
    expect(full.more.map((m) => m.action)).toEqual(['paste_summary']);
    // Nothing saved lately: only Search.
    const none = assignEmptySlots({ editable: true, recent: 0, summaryModel: true }, router);
    expect([none.slot3?.action, none.slot4, none.more]).toEqual(['search', null, []]);
    // The focus doesn't take text: pasting goes to the clipboard, so it waits under More.
    const readOnly = assignEmptySlots({ editable: false, recent: 3, summaryModel: true }, router);
    expect(readOnly.slot4).toBeNull();
    expect(readOnly.more.map((m) => m.action)).toEqual(['paste_list', 'paste_summary']);
    // Writing in a field: "Write it for here" goes ahead of the plain list, even with nothing recent.
    const writing = assignEmptySlots({ editable: true, recent: 0, summaryModel: true, writing: true }, router);
    expect([writing.slot3?.action, writing.slot4?.action]).toEqual(['search', 'paste_summary']);
    // No model: the summary stays under More, where it says why.
    expect(scoreEmptyActions({ editable: null, recent: 2, summaryModel: false }).paste_summary).toBeGreaterThan(router.moreThreshold);
  });
});
