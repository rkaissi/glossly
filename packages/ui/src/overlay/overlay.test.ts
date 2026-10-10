import { describe, expect, it } from 'vitest';
import type { SlotsView, SlotView } from '@glossly/core/api';
import { barItems, barKey, slotKey, type BarKeyContext, type KeyInput } from './keys';
import { parseInline, parseMarkdown } from './markdown';

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
  it('numbers the buttons by position, so the empty bar has no gap where Save would be', () => {
    const empty: SlotsView = { ...slots, slot3: slot('search', true), slot4: slot('paste_list', true), more: [] };
    const items = barItems(empty, false, false);
    expect([slotKey(items, 1), slotKey(items, 3), slotKey(items, 4)]).toEqual([1, 2, 3]);
    expect(barKey(key('2'), ctx({ items }))).toEqual({ kind: 'run', target: { slot: 3 } });
    expect(barKey(key('3'), ctx({ items }))).toEqual({ kind: 'run', target: { slot: 4 } });
    expect(barKey(key('4'), ctx({ items }))).toBeNull();
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
