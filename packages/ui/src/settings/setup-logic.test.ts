import { describe, expect, it } from 'vitest';
import { canContinue, joinContacts, splitContacts, tickTry } from './setup-logic';

describe('canContinue', () => {
  const base = { privacy: 'all' as const, hasModel: false, name: '' };
  it('needs a working model under All models', () => {
    expect(canContinue('connect', base)).toBe(false);
    expect(canContinue('connect', { ...base, hasModel: true })).toBe(true);
  });
  it('lets Local only go on without a model', () => {
    expect(canContinue('connect', { ...base, privacy: 'local' })).toBe(true);
  });
  it('needs a name', () => {
    expect(canContinue('you', { ...base, name: '  ' })).toBe(false);
    expect(canContinue('you', { ...base, name: 'Alex Morgan' })).toBe(true);
  });
  it('never blocks the other steps', () => {
    for (const step of ['welcome', 'privacy', 'models', 'search', 'try'] as const) expect(canContinue(step, base)).toBe(true);
  });
});

describe('splitContacts', () => {
  it('splits emails from handles', () => {
    expect(splitContacts('Alex@Example.com, @alexm; alex.m')).toEqual({ emails: ['alex@example.com'], handles: ['alexm', 'alex.m'] });
  });
  it('keeps handles with spaces and drops empties and repeats', () => {
    expect(splitContacts(' Alex M ,, alex@example.com, ALEX@example.com,\n@@')).toEqual({ emails: ['alex@example.com'], handles: ['Alex M'] });
  });
  it('is empty for nothing', () => {
    expect(splitContacts('')).toEqual({ emails: [], handles: [] });
  });
  it('round-trips with joinContacts', () => {
    const i = { emails: ['alex@example.com'], handles: ['alexm'] };
    expect(joinContacts(i)).toBe('alex@example.com, @alexm');
    expect(splitContacts(joinContacts(i))).toEqual(i);
  });
});

describe('tickTry', () => {
  it('ticks in order and never unticks', () => {
    expect(tickTry(0, 'pill')).toBe(1);
    expect(tickTry(1, 'bar')).toBe(2);
    expect(tickTry(3, 'pill')).toBe(3);
  });
  it('counts earlier items done when a later one happens (the hotkey skips the pill)', () => {
    expect(tickTry(0, 'bar')).toBe(2);
    expect(tickTry(0, 'action')).toBe(3);
  });
});
