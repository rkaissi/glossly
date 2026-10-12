import { describe, expect, it } from 'vitest';
import type { RouteResult } from '@glossly/core';
import { ExpiringLru, Lru, replyCacheKey, actionForSlot, distanceToRect, emptySlotsView, fitOnScreen, growFrom, holdForRoute, mergeRoute, mouseAwayLimit, needsTier2, saveLabel, shouldHideOverlay, slotsView, sourceRoom } from './view';

const area = { x: 0, y: 0, w: 1000, h: 800 };

function route(partial: Partial<RouteResult['slots']> = {}, collection = 'Notes'): RouteResult {
  return {
    decisions: {
      content_type: 'single_message',
      authored_by_other: 0.9,
      mentions_people: 0.1,
      contains_commitment: 0.7,
      best_collection: collection,
      provider: 'rules',
    },
    slots: {
      slot3: { action: 'reply', score: 0.9 },
      slot4: { action: 'promises', score: 0.7 },
      more: [],
      scores: { reply: 0.9, who: 0.1, promises: 0.7, visualize: 0 },
      ...partial,
    },
    features: {} as RouteResult['features'],
    ms: 3.4,
    fallback: null,
  };
}

describe('slotsView', () => {
  it('labels slots, with every action available now that Visualize is built', () => {
    const v = slotsView(route(), 'rules');
    expect(v.slot1).toMatchObject({ action: 'ask', label: 'Ask', available: true });
    expect(v.slot2).toMatchObject({ action: 'save', label: 'Save to Notes', collection: 'Notes', available: true });
    expect(v.slot3).toMatchObject({ action: 'reply', available: true, score: 0.9 });
    expect(v.slot4).toMatchObject({ action: 'promises', label: 'Tasks and events', available: true });
    expect(slotsView(route({ slot3: { action: 'visualize', score: 1 } }), 'rules').slot3).toMatchObject({ action: 'visualize', label: 'Visualize', available: true });
    expect(v.route_ms).toBe(3);
  });

  it('fills empty slots from the settled route and does not remove a button already shown', () => {
    const waiting = holdForRoute(slotsView(route({}, 'Notes'), 'rules'));
    expect(waiting.slot3).toBeNull();
    expect(waiting.slot4).toBeNull();
    expect(waiting.more).toEqual([]);
    expect(waiting.stage).toBe('pending');
    expect(waiting.slot2.collection).toBe('Notes');

    const settled = slotsView(route({ slot3: { action: 'who', score: 0.8 }, slot4: null, more: [{ action: 'promises', score: 0.4 }] }, 'Reading'), 'model');
    const merged = mergeRoute(waiting, settled);
    expect(merged.slot2.collection).toBe('Reading');
    expect(merged.slot3?.action).toBe('who');
    expect(merged.slot4).toBeNull();
    expect(merged.more.map((m) => m.action)).toEqual(['promises']);
    expect(merged.stage).toBe('model');

    const again = slotsView(route({ slot3: null, slot4: null, more: [] }, 'Ideas'), 'rules_fallback');
    const kept = mergeRoute(merged, again);
    expect(kept.slot2.collection).toBe('Reading');
    expect(kept.slot3?.action).toBe('who');
    expect(kept.more.map((m) => m.action)).toEqual(['promises']);

    const open = mergeRoute(waiting, settled, { keepSave: true });
    expect(open.slot2.collection).toBe('Notes');
    expect(open.slot3?.action).toBe('who');

    const swapped = mergeRoute(kept, slotsView(route({ slot3: { action: 'reply', score: 0.5 } }, 'Notes'), 'model'));
    expect(swapped.slot3?.action).toBe('who');

    const moved = mergeRoute(kept, slotsView(route({ slot3: { action: 'reply', score: 0.6 }, slot4: { action: 'who', score: 0.5 }, more: [{ action: 'who', score: 0.5 }] }, 'Notes'), 'model'));
    expect(moved.slot3?.action).toBe('who');
    expect(moved.slot4).toBeNull();
    expect(moved.more.map((m) => m.action)).not.toContain('who');
    expect(moved.more.map((m) => m.action)).toContain('reply');
  });
});

describe('actionForSlot', () => {
  it('maps fixed and contextual slots', () => {
    const v = slotsView(route({ slot4: null }), 'rules');
    expect(actionForSlot(v, 1)).toBe('ask');
    expect(actionForSlot(v, 2)).toBe('save');
    expect(actionForSlot(v, 3)).toBe('reply');
    expect(actionForSlot(v, 4)).toBeNull();
    expect(actionForSlot(null, 3)).toBeNull();
  });
});

describe('growFrom', () => {
  it('keeps the top-left corner when the pill is below the selection', () => {
    expect(growFrom({ x: 100, y: 200, w: 168, h: 40 }, 'below', { w: 460, h: 56 }, area)).toEqual({ x: 100, y: 200, w: 460, h: 56 });
  });

  it('keeps the bottom edge when the pill is above the selection', () => {
    expect(growFrom({ x: 100, y: 500, w: 168, h: 40 }, 'above', { w: 460, h: 300 }, area)).toEqual({ x: 100, y: 240, w: 460, h: 300 });
    // No room above: clamped to the top of the work area.
    expect(growFrom({ x: 100, y: 200, w: 168, h: 40 }, 'above', { w: 460, h: 300 }, area)).toEqual({ x: 100, y: 0, w: 460, h: 300 });
  });

  it('keeps the left edge as the bar grows rightward to its widest', () => {
    // Placement left room for 680 px at x 320, so growing never shifts the window.
    expect(growFrom({ x: 320, y: 200, w: 200, h: 40 }, 'below', { w: 680, h: 40 }, area)).toEqual({ x: 320, y: 200, w: 680, h: 40 });
    expect(growFrom({ x: 320, y: 500, w: 680, h: 40 }, 'above', { w: 680, h: 320 }, area)).toEqual({ x: 320, y: 220, w: 680, h: 320 });
  });

  it('stays inside the work area', () => {
    expect(growFrom({ x: 900, y: 780, w: 168, h: 40 }, 'below', { w: 460, h: 56 }, area)).toEqual({ x: 540, y: 744, w: 460, h: 56 });
  });

  it('shrinks a window that is wider than the work area instead of hanging off the edge', () => {
    expect(growFrom({ x: 400, y: 100, w: 200, h: 40 }, 'below', { w: 900, h: 40 }, { x: 0, y: 0, w: 500, h: 400 })).toEqual({
      x: 0,
      y: 100,
      w: 500,
      h: 40,
    });
  });
});

describe('fitOnScreen', () => {
  const limits = { minW: 40, maxW: 680, minH: 16, maxH: 640 };

  it('shifts left so a bar near the right edge stays on screen', () => {
    expect(fitOnScreen({ x: 800, y: 200, w: 200, h: 40 }, 680, 40, area, false, limits)).toEqual({ x: 320, y: 200, w: 680, h: 40 });
  });

  it('shrinks to the work area when the screen is narrower than the bar', () => {
    const narrow = { x: 10, y: 20, w: 400, h: 300 };
    expect(fitOnScreen({ x: 10, y: 40, w: 200, h: 40 }, 680, 800, narrow, false, limits)).toEqual({ x: 10, y: 20, w: 400, h: 300 });
  });

  it('keeps the bottom edge when the bar sits above the selection', () => {
    expect(fitOnScreen({ x: 100, y: 500, w: 200, h: 40 }, 400, 200, area, true, limits)).toEqual({ x: 100, y: 340, w: 400, h: 200 });
  });
});

describe('mouseAwayLimit (decision 55)', () => {
  it('keeps the setting, or allows half of it more than where the cursor started', () => {
    expect(mouseAwayLimit(40, 200)).toBe(200);
    // A pill placed 260 px away (past a toolbar) hides only once the cursor is 360 px away.
    expect(mouseAwayLimit(260, 200)).toBe(360);
  });
});

describe('shouldHideOverlay', () => {
  const pill = { visible: true, focused: false, settling: false };

  it('hides an unfocused pill on typing, scrolling, or the cursor leaving', () => {
    expect(shouldHideOverlay({ ...pill, signal: 'keyboard_activity' })).toBe(true);
    expect(shouldHideOverlay({ ...pill, signal: 'wheel' })).toBe(true);
    expect(shouldHideOverlay({ ...pill, signal: 'mouse_away' })).toBe(true);
    expect(shouldHideOverlay({ ...pill, signal: 'foreground' })).toBe(true);
  });

  it('keeps a focused bar up except when it blurs', () => {
    const bar = { visible: true, focused: true, settling: false };
    expect(shouldHideOverlay({ ...bar, signal: 'keyboard_activity' })).toBe(false);
    expect(shouldHideOverlay({ ...bar, signal: 'mouse_away' })).toBe(false);
    expect(shouldHideOverlay({ ...bar, signal: 'foreground' })).toBe(false);
    expect(shouldHideOverlay({ ...bar, signal: 'blur' })).toBe(true);
  });

  it('does not let the hotkey that opened the bar close it while focus is landing', () => {
    const opening = { visible: true, focused: false, settling: true };
    expect(shouldHideOverlay({ ...opening, signal: 'keyboard_activity' })).toBe(false);
    expect(shouldHideOverlay({ ...opening, signal: 'mouse_away' })).toBe(false);
    expect(shouldHideOverlay({ ...opening, signal: 'foreground' })).toBe(false);
    expect(shouldHideOverlay({ ...opening, signal: 'blur' })).toBe(false);
    // Focus has landed: a blur is the user leaving, even inside the grace.
    expect(shouldHideOverlay({ ...opening, signal: 'blur', osFocused: true })).toBe(true);
    // A scroll during the grace is still the user leaving the pill.
    expect(shouldHideOverlay({ ...opening, signal: 'wheel' })).toBe(true);
  });

  it('ignores a foreground change to the source window or to Glossly', () => {
    expect(shouldHideOverlay({ ...pill, signal: 'foreground', ownForeground: true })).toBe(false);
  });

  it('does nothing when the overlay is hidden', () => {
    expect(shouldHideOverlay({ signal: 'keyboard_activity', visible: false, focused: false, settling: false })).toBe(false);
  });
});

describe('empty selection', () => {
  it('puts Search and a paste action in slots 3 and 4, and reads tier 2 only for actions that send or store the text', () => {
    const v = emptySlotsView({ slot3: { action: 'search', score: 0.9 }, slot4: { action: 'paste_list', score: 0.8 }, more: [{ action: 'paste_summary', score: 0.25 }], scores: {} });
    expect(actionForSlot(v, 3)).toBe('search');
    expect(actionForSlot(v, 4)).toBe('paste_list');
    expect(v.more.map((m) => m.label)).toEqual(['Write it for here']);
    expect(needsTier2('ask')).toBe(true);
    expect(needsTier2('search')).toBe(false);
    expect(needsTier2('recall')).toBe(false);
  });
});

describe('distanceToRect', () => {
  const r = { x: 10, y: 10, w: 100, h: 20 };
  it('is zero inside and the edge distance outside', () => {
    expect(distanceToRect({ x: 50, y: 20 }, r)).toBe(0);
    expect(distanceToRect({ x: 50, y: 230 }, r)).toBe(200);
    expect(distanceToRect({ x: 113, y: 34 }, r)).toBe(5);
  });
});

describe('Lru', () => {
  it('forgets the least recently used entry, and a read counts as a use', () => {
    const c = new Lru<string, number>(2);
    c.set('a', 1);
    c.set('b', 2);
    expect(c.get('a')).toBe(1);
    c.set('c', 3);
    expect([c.get('a'), c.get('b'), c.get('c')]).toEqual([1, undefined, 3]);
    c.clear();
    expect(c.get('a')).toBeUndefined();
  });
});

describe("Reply's cache key", () => {
  const base = { place: '- slack', author: null, text: 'sounds good?' };

  it('is a hash of the place, the author when found, and the text, ignoring whitespace and case of the place', () => {
    const k = replyCacheKey(base);
    expect(k).toMatch(/^[0-9a-f]{64}$/);
    expect(replyCacheKey({ ...base, text: '  sounds\n good? ' })).toBe(k);
    expect(replyCacheKey({ ...base, place: '- Slack' })).toBe(k);
    expect(replyCacheKey({ ...base, place: 'discord.exe' })).not.toBe(k);
    expect(replyCacheKey({ ...base, author: 'Maya Lin' })).not.toBe(k);
    expect(replyCacheKey({ ...base, author: 'Maya Lin' })).not.toBe(replyCacheKey({ ...base, author: 'Jordan Hale' }));
  });

  it('expires entries', () => {
    let now = 0;
    const cache = new ExpiringLru<string, number>(2, 1000, () => now);
    cache.set('a', 1);
    now = 999;
    expect(cache.get('a')).toBe(1);
    now = 1001;
    expect(cache.get('a')).toBeUndefined();
  });
});

describe('saveLabel', () => {
  it('says "Save to" while it fits the slot, else the collection alone', () => {
    expect(saveLabel('Notes')).toBe('Save to Notes');
    expect(saveLabel('Reading')).toBe('Save to Reading');
    expect(saveLabel('People notes')).toBe('People notes');
    expect(slotsView(route({}, 'Client research'), 'rules').slot2).toMatchObject({ label: 'Client research', collection: 'Client research' });
  });
});

describe('sourceRoom', () => {
  const source = { x: 100, y: 100, w: 1000, h: 700 };
  it('is the height left inside the source window toward the side the panel grows', () => {
    expect(sourceRoom({ x: 300, y: 400, w: 400, h: 40 }, 'below', source, 320)).toBe(400);
    expect(sourceRoom({ x: 300, y: 500, w: 400, h: 40 }, 'above', source, 320)).toBe(440);
  });
  it('lets the screen decide when the source is unknown, the bar sits outside it, or the room is too small', () => {
    expect(sourceRoom({ x: 300, y: 400, w: 400, h: 40 }, 'below', null, 320)).toBeNull();
    expect(sourceRoom({ x: 300, y: 790, w: 400, h: 40 }, 'below', source, 320)).toBeNull();
    expect(sourceRoom({ x: 300, y: 600, w: 400, h: 40 }, 'below', source, 320)).toBeNull();
  });
});
