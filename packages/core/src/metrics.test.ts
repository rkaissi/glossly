import { afterEach, describe, expect, it } from 'vitest';
import { Metrics, sanitizePayload } from './metrics';
import { Store } from './store/store';

let store: Store;
afterEach(() => store?.close());

describe('sanitizePayload', () => {
  it('keeps numbers, booleans, and identifier strings only', () => {
    expect(
      sanitizePayload({
        action: 'ask',
        model: 'groq:llama-3.1-8b-instant',
        ms: 312,
        ok: true,
        text: 'Sam said the launch moves',
        long: 'x'.repeat(41),
        nan: Number.NaN,
        nested: { a: 1 },
        list: [1],
        'bad key': 1,
      }),
    ).toEqual({ action: 'ask', model: 'groq:llama-3.1-8b-instant', ms: 312, ok: true });
    expect(sanitizePayload({ text: 'hello there' })).toBeNull();
    expect(sanitizePayload(null)).toBeNull();
  });
});

describe('Metrics', () => {
  it('ignores bad kinds and never stores text', () => {
    store = new Store(':memory:');
    const m = new Metrics(store);
    m.record('not a kind');
    m.record('ask_error', { message: 'secret selection text' });
    expect(store.listEvents()).toEqual([expect.objectContaining({ kind: 'ask_error', payload: null })]);
  });

  it('summarizes per day with click rates and median time to action', () => {
    store = new Store(':memory:');
    let now = new Date(2026, 9, 8, 12);
    const m = new Metrics(store, () => now);
    m.record('pill_shown');
    m.record('pill_shown');
    m.record('bar_shown', { trigger: 'auto' });
    m.record('action_clicked', { action: 'ask', ms: 900 });
    now = new Date(2026, 9, 9, 9);
    m.record('hotkey');
    m.record('bar_shown', { trigger: 'hotkey' });
    m.record('action_clicked', { action: 'ask', ms: 300 });
    m.record('action_clicked', { action: 'save', ms: 500 });
    m.record('action_clicked', { action: 'ask', ms: 600 });
    now = new Date(2026, 8, 1);
    m.record('hotkey');
    now = new Date(2026, 9, 9, 18);

    const s = m.summary(2);
    expect(s.days.map((d) => d.date)).toEqual(['2026-10-08', '2026-10-09']);
    expect(s.days[0]).toMatchObject({ pill_shown: 2, bar_shown: 1, hotkey: 0, actions: { ask: 1 } });
    expect(s.days[1]).toMatchObject({ hotkey: 1, bar_shown: 1, actions: { ask: 2, save: 1 } });
    expect(s.totals).toEqual({ hotkey: 1, pill_shown: 2, bar_shown: 2, triggers: 3 });
    expect(s.expand_rate).toBe(0.5);
    expect(s.actions.ask).toEqual({ clicks: 3, click_rate: 1, median_ms: 600 });
    expect(s.actions.save).toEqual({ clicks: 1, click_rate: 1 / 3, median_ms: 500 });
  });
});
