import { describe, expect, it } from 'vitest';
import type { RouteResult } from '@glossly/core';
import { actionForSlot, distanceToRect, growFrom, mergeRoute, slotsView } from './view';

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
  it('labels slots and marks later-phase actions unavailable', () => {
    const v = slotsView(route(), 'rules');
    expect(v.slot1).toMatchObject({ action: 'ask', label: 'Ask', available: true });
    expect(v.slot2).toMatchObject({ action: 'save', label: 'Save to Notes', collection: 'Notes', available: true });
    expect(v.slot3).toMatchObject({ action: 'reply', available: true, score: 0.9 });
    expect(v.slot4).toMatchObject({ action: 'promises', label: 'What did I promise', available: true });
    expect(slotsView(route({ slot3: { action: 'visualize', score: 1 } }), 'rules').slot3).toMatchObject({ action: 'visualize', available: false });
    expect(v.route_ms).toBe(3);
  });

  it('keeps slots 1 and 2 from the first paint when the model answers', () => {
    const first = slotsView(route({}, 'Notes'), 'rules');
    const next = slotsView(route({ slot3: { action: 'who', score: 0.8 }, slot4: null }, 'Reading'), 'model');
    const merged = mergeRoute(first, next);
    expect(merged.slot2.collection).toBe('Notes');
    expect(merged.slot3?.action).toBe('who');
    expect(merged.slot4).toBeNull();
    expect(merged.stage).toBe('model');
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
});

describe('distanceToRect', () => {
  const r = { x: 10, y: 10, w: 100, h: 20 };
  it('is zero inside and the edge distance outside', () => {
    expect(distanceToRect({ x: 50, y: 20 }, r)).toBe(0);
    expect(distanceToRect({ x: 50, y: 230 }, r)).toBe(200);
    expect(distanceToRect({ x: 113, y: 34 }, r)).toBe(5);
  });
});
