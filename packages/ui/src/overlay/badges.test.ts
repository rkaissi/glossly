import { describe, expect, it } from 'vitest';
import type { Badge } from '@glossly/core/api';
import { shownBadges } from './badges';

const person = (personId: string, label: string): Badge => ({ kind: 'person', personId, label });

describe('shownBadges', () => {
  it('keeps a single person badge as it is', () => {
    expect(shownBadges([person('p1', 'Jordan Hale · 1 open')])).toEqual([
      { badge: person('p1', 'Jordan Hale · 1 open'), title: 'Who is Jordan Hale' },
    ]);
  });

  it('collapses several people so the bar does not run off the screen', () => {
    const shown = shownBadges([
      person('p1', 'Jordan Hale'),
      person('p2', 'Casey Morgan'),
      person('p3', 'Sam Okonkwo · 2 open'),
      { kind: 'recall', count: 2 },
    ]);
    expect(shown.map((s) => s.badge)).toEqual([
      person('p1', 'Jordan +2 others'),
      { kind: 'recall', count: 2 },
    ]);
    expect(shown[0]!.title).toBe('Jordan Hale, Casey Morgan, Sam Okonkwo');
  });

  it('says "other" for exactly one more person', () => {
    expect(shownBadges([person('p1', 'Jordan Hale'), person('p2', 'Casey Morgan')])[0]!.badge).toMatchObject({
      label: 'Jordan +1 other',
    });
  });
});
