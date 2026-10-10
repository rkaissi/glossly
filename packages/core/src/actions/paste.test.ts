import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../settings';
import { assignEmptySlots, scoreEmptyActions } from '../router/slots';
import { Store } from '../store/store';
import { buildPasteSummaryPrompt, pasteAsSaved, pasteList, recentSnippets } from './paste';

const at = (daysAgo: number) => {
  const d = new Date(Date.UTC(2026, 9, 10, 12) - daysAgo * 86_400_000);
  return d.toISOString().replace('Z', '+00:00');
};

describe('paste', () => {
  it('lists recent snippets oldest first, one line each, and leaves old ones out', () => {
    const store = new Store(':memory:');
    try {
      const notes = store.collectionByName('Notes')!;
      const add = (text: string, daysAgo: number) =>
        store.insertItem({ collection_id: notes.id, kind: 'selection', text, why: null, source_app: null, window_title: null, data_json: null, created_at: at(daysAgo) });
      add('Too old', 9);
      add('The launch moved\nto Thursday', 2);
      add('Budget is 40k', 1);
      const items = recentSnippets(store, DEFAULT_SETTINGS, Date.UTC(2026, 9, 10, 12));
      expect(items.map((i) => i.text)).toEqual(['Budget is 40k', 'The launch moved\nto Thursday']);
      expect(pasteList(items)).toBe('- The launch moved to Thursday\n- Budget is 40k');
      expect(pasteAsSaved(items)).toBe('The launch moved\nto Thursday\n\nBudget is 40k');
      expect(buildPasteSummaryPrompt(items)).toContain('<snippet n="1" saved="2026-10-08">');
    } finally {
      store.close();
    }
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
    // No model: the summary stays under More, where it says why.
    expect(scoreEmptyActions({ editable: null, recent: 2, summaryModel: false }).paste_summary).toBeGreaterThan(router.moreThreshold);
  });
});
