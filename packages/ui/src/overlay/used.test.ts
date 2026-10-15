import { describe, expect, it } from 'vitest';
import { usedSummary } from './used';

describe('usedSummary', () => {
  it('counts each kind in a fixed order, singular or plural', () => {
    expect(usedSummary([{ kind: 'event' }, { kind: 'note' }, { kind: 'note' }])).toBe('Used 2 notes · 1 event');
    expect(usedSummary([{ kind: 'person' }, { kind: 'person' }, { kind: 'task' }])).toBe('Used 2 people · 1 task');
    expect(usedSummary([])).toBe('');
  });
});
