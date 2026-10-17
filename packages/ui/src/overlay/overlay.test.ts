import { describe, expect, it } from 'vitest';
import type { SlotsView, SlotView } from '@glossly/core/api';
import { barItems, barKey, panelKey, slotKey, type BarKeyContext, type KeyInput } from './keys';
import { parseInline, parseMarkdown, tidyText } from './markdown';

const slot = (action: SlotView['action'], available = false): SlotView => ({ action, label: action, available });

const slots: SlotsView = {
  slot1: slot('ask', true),
  slot2: { ...slot('save', true), collection: 'Notes' },
  slot3: slot('reply'),
  slot4: null,
  more: [slot('visualize')],
  stage: 'rules',
  content_type: 'single_message',
  provider: 'rules',
  fallback: 'no_model',
  route_ms: 3,
};

const key = (k: string, mods: Partial<KeyInput> = {}): KeyInput => ({ key: k, ctrl: false, alt: false, meta: false, shift: false, ...mods });
const ctx = (over: Partial<BarKeyContext> = {}): BarKeyContext => ({ items: barItems(slots, true, false), highlight: 0, menuOpen: false, ...over });

describe('barItems', () => {
  it('lists filled slots, and More only while the menu is open', () => {
    expect(barItems(slots, true, false)).toEqual([{ slot: 1 }, { slot: 2 }, { slot: 3 }]);
    expect(barItems(slots, true, true)).toEqual([{ slot: 1 }, { slot: 2 }, { slot: 3 }, { action: 'visualize' }]);
  });
  it('drops Save with nothing selected, and keeps Search in slot 3', () => {
    expect(barItems(null, false, true)).toEqual([{ slot: 1 }]);
    const empty: SlotsView = { ...slots, slot3: slot('search', true), slot4: null, more: [] };
    expect(barItems(empty, false, false)).toEqual([{ slot: 1 }, { slot: 3 }]);
  });
});

describe('barKey', () => {
  it('runs filled slots by number and ignores empty ones', () => {
    expect(barKey(key('3'), ctx())).toEqual({ kind: 'run', target: { slot: 3 } });
    expect(barKey(key('4'), ctx())).toBeNull();
    expect(barKey(key('2'), ctx({ items: barItems(null, false, false) }))).toBeNull();
  });
  it('numbers the buttons by position: the empty bar is 1 Ask, 2 Search, 3 and 4 (decision 82)', () => {
    const empty: SlotsView = { ...slots, slot2: { ...slot('search', true), collection: '' }, slot3: slot('reply', true), slot4: slot('write', true), more: [] };
    const items = barItems(empty, false, false);
    expect([slotKey(items, 1), slotKey(items, 2), slotKey(items, 3), slotKey(items, 4)]).toEqual([1, 2, 3, 4]);
    expect(barKey(key('2'), ctx({ items }))).toEqual({ kind: 'run', target: { slot: 2 } });
    expect(barKey(key('4'), ctx({ items }))).toEqual({ kind: 'run', target: { slot: 4 } });
    // An empty bar with only Write here: no gap after Search.
    const one = barItems({ ...empty, slot3: slot('write', true), slot4: null }, false, false);
    expect(barKey(key('3'), ctx({ items: one }))).toEqual({ kind: 'run', target: { slot: 3 } });
    expect(barKey(key('4'), ctx({ items: one }))).toBeNull();
    expect(slotKey(barItems(slots, true, false), 3)).toBe(3);
  });
  it('runs the highlighted item on Enter', () => {
    expect(barKey(key('Enter'), ctx({ highlight: 1 }))).toEqual({ kind: 'run', target: { slot: 2 } });
    expect(barKey(key('Enter'), ctx({ items: barItems(slots, true, true), menuOpen: true, highlight: 3 }))).toEqual({
      kind: 'run',
      target: { action: 'visualize' },
    });
  });
  it('opens the menu (with More) on Tab, and closes it before the bar on Esc', () => {
    expect(barKey(key('Tab'), ctx())).toEqual({ kind: 'menu', open: true });
    expect(barKey(key('Tab'), ctx({ menuOpen: true }))).toEqual({ kind: 'menu', open: false });
    expect(barKey(key('Escape'), ctx({ menuOpen: true }))).toEqual({ kind: 'menu', open: false });
    expect(barKey(key('Escape'), ctx())).toEqual({ kind: 'close' });
  });
  it('wraps the highlight with the arrow keys', () => {
    expect(barKey(key('ArrowLeft'), ctx())).toEqual({ kind: 'highlight', index: 2 });
    expect(barKey(key('ArrowRight'), ctx({ highlight: 2 }))).toEqual({ kind: 'highlight', index: 0 });
  });
  it('moves through More with Down and Up while the menu is open', () => {
    const open = ctx({ items: barItems(slots, true, true), menuOpen: true, highlight: 3 });
    expect(barKey(key('ArrowUp'), open)).toEqual({ kind: 'highlight', index: 2 });
    expect(barKey(key('ArrowDown'), open)).toEqual({ kind: 'highlight', index: 0 });
  });
  it('keeps 1 to 4 working while the menu is open', () => {
    expect(barKey(key('3'), ctx({ items: barItems(slots, true, true), menuOpen: true }))).toEqual({ kind: 'run', target: { slot: 3 } });
  });
  it('lets modified keys through', () => {
    expect(barKey(key('1', { ctrl: true }), ctx())).toBeNull();
    expect(barKey(key('c', { ctrl: true }), ctx())).toBeNull();
    expect(barKey(key('Enter', { alt: true }), ctx())).toBeNull();
  });
  it('runs slots with Alt and a number too', () => {
    expect(barKey(key('3', { alt: true }), ctx())).toEqual({ kind: 'run', target: { slot: 3 } });
  });
});

describe('panelKey', () => {
  // The empty bar in a reply box: Ask, Reply, Search, with the Search panel open and its box focused.
  const field: SlotsView = { ...slots, slot3: slot('reply', true), slot4: slot('search', true), more: [] };
  const items = barItems(field, false, false);

  it('leaves plain number keys to the panel, so they type into the search box', () => {
    expect(panelKey(key('2'), items, 4)).toBeNull();
    expect(panelKey(key('1'), items, 4)).toBeNull();
  });
  it('opens another slot with Alt and its number', () => {
    expect(slotKey(items, 3)).toBe(2);
    expect(panelKey(key('2', { alt: true }), items, 4)).toEqual({ kind: 'run', target: { slot: 3 } });
    expect(panelKey(key('1', { alt: true }), items, 4)).toEqual({ kind: 'run', target: { slot: 1 } });
  });
  it('does nothing for the open panel’s own slot or a missing one', () => {
    expect(panelKey(key('3', { alt: true }), items, 4)).toBeNull();
    expect(panelKey(key('4', { alt: true }), items, 4)).toBeNull();
    expect(panelKey(key('2', { alt: true, ctrl: true }), items, 4)).toBeNull();
  });
});

describe('parseMarkdown', () => {
  it('parses inline code and bold', () => {
    expect(parseInline('Use `npm i` **now**.')).toEqual([
      { t: 'text', v: 'Use ' },
      { t: 'code', v: 'npm i' },
      { t: 'text', v: ' ' },
      { t: 'bold', v: 'now' },
      { t: 'text', v: '.' },
    ]);
  });
  it('splits paragraphs, headings, and lists', () => {
    const md = '# Title\nFirst line\nsecond line\n\n- one\n  more\n- two\n1. a\n2. b\nAfter';
    expect(parseMarkdown(md)).toEqual([
      { t: 'h', inl: [{ t: 'text', v: 'Title' }] },
      { t: 'p', inl: [{ t: 'text', v: 'First line\nsecond line' }] },
      { t: 'ul', items: [[{ t: 'text', v: 'one more' }], [{ t: 'text', v: 'two' }]] },
      { t: 'ol', items: [[{ t: 'text', v: 'a' }], [{ t: 'text', v: 'b' }]] },
      { t: 'p', inl: [{ t: 'text', v: 'After' }] },
    ]);
  });
  it('keeps an unclosed code fence while streaming', () => {
    expect(parseMarkdown('Look:\n```ts\nconst a = 1;')).toEqual([
      { t: 'p', inl: [{ t: 'text', v: 'Look:' }] },
      { t: 'code', v: 'const a = 1;' },
    ]);
  });
  it('leaves an unclosed bold marker as text', () => {
    expect(parseInline('half **bold')).toEqual([{ t: 'text', v: 'half **bold' }]);
  });
});

describe('tidyText', () => {
  it('turns narrow and no-break spaces into plain ones (they could render with no width)', () => {
    expect(tidyText('Meet at\u202f10\u202fa.m. on\u00a0Friday')).toBe('Meet at 10 a.m. on Friday');
  });
  it('drops the full stop doubled after an abbreviation, and keeps an ellipsis', () => {
    expect(tidyText('It starts at 10 a.m.. Bring the deck.')).toBe('It starts at 10 a.m. Bring the deck.');
    expect(tidyText('Lists, e.g.. this one')).toBe('Lists, e.g. this one');
    expect(tidyText('Wait for it...')).toBe('Wait for it...');
    expect(tidyText('Ends at 5 p.m.')).toBe('Ends at 5 p.m.');
  });
  it('leaves inline code alone', () => {
    expect(parseInline('Run `a\u00a0b..` at\u202f9')).toEqual([
      { t: 'text', v: 'Run ' },
      { t: 'code', v: 'a\u00a0b..' },
      { t: 'text', v: ' at 9' },
    ]);
  });
});
