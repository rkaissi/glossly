import { describe, expect, it } from 'vitest';
import type { CommitmentView } from '../people/types';
import { isoNow } from '../types';
import { findDuplicateEvent, findDuplicateTask, sameSlot, titlesMatch } from './duplicates';
import type { CalendarEvent } from './types';

const at = (d: number, h: number, m = 0) => isoNow(new Date(2026, 9, d, h, m));
const ev = (title: string, starts_at: string, ends_at: string | null = null, all_day = false): CalendarEvent => ({
  id: title,
  title,
  starts_at,
  ends_at,
  all_day,
  location: null,
  attendees: [],
  people: [],
  source_app: null,
  created_at: at(1, 9),
});

describe('titlesMatch', () => {
  it('needs a shared distinctive word, not just the kind of event', () => {
    expect(titlesMatch('Lunch with Jordan', 'Jordan lunch')).toBe(true);
    expect(titlesMatch("Mom's birthday dinner", 'Birthday dinner for Mom')).toBe(true);
    expect(titlesMatch('Interview with Northwind', 'Northwind design interview')).toBe(true);
    expect(titlesMatch('Call with Jordan Hale', 'Jordan 1:1')).toBe(true);
    expect(titlesMatch('Q4 offsite planning', 'Offsite planning meeting')).toBe(true);
    expect(titlesMatch('Lunch with Jordan', 'Lunch with Casey')).toBe(false);
    expect(titlesMatch('Flight to Toronto', 'Flight to Lisbon')).toBe(false);
    expect(titlesMatch('Q4 offsite planning', 'Q4 budget review')).toBe(false);
    expect(titlesMatch('Dentist', 'Teeth cleaning')).toBe(false);
  });
});

describe('sameSlot', () => {
  it('overlapping times on one day, or the same day when either is all day', () => {
    expect(sameSlot(ev('a', at(15, 13), at(15, 14)), ev('b', at(15, 13, 30)))).toBe(true);
    expect(sameSlot(ev('a', at(15, 13), at(15, 14)), ev('b', at(15, 14), at(15, 15)))).toBe(false);
    expect(sameSlot(ev('a', '2026-10-15', null, true), ev('b', at(15, 9)))).toBe(true);
    expect(sameSlot(ev('a', at(15, 13)), ev('b', at(16, 13)))).toBe(false);
  });
});

describe('findDuplicateEvent', () => {
  const day = [ev('Lunch with Jordan', at(15, 13), at(15, 14)), ev('Interview with Northwind', at(15, 15), at(15, 16)), ev('Conference', '2026-10-15', null, true)];

  it('finds the same event by its words in its slot', async () => {
    expect((await findDuplicateEvent({ title: 'Jordan lunch', starts_at: at(15, 13), ends_at: null, all_day: false }, day))?.title).toBe('Lunch with Jordan');
    expect(await findDuplicateEvent({ title: 'Jordan lunch', starts_at: at(15, 18), ends_at: null, all_day: false }, day)).toBeNull();
    expect(await findDuplicateEvent({ title: 'Lunch with Casey', starts_at: at(15, 13), ends_at: null, all_day: false }, day)).toBeNull();
  });

  it('lets meaning decide only when it is very close, between timed events', async () => {
    const sim = (score: number) => async (_a: string, b: string[]) => b.map(() => score);
    const c = { title: 'Talent screen', starts_at: at(15, 15, 30), ends_at: null, all_day: false };
    expect((await findDuplicateEvent(c, day, sim(0.9)))?.title).toBe('Interview with Northwind');
    expect(await findDuplicateEvent(c, day, sim(0.6))).toBeNull();
    expect(await findDuplicateEvent({ ...c, starts_at: '2026-10-15', all_day: true }, day, sim(0.9))).toBeNull();
  });
});

describe('findDuplicateTask', () => {
  const task = (id: string, text: string, person_id: string | null): CommitmentView => ({ id, owner: 'me', text, due_at: null, status: 'open', completed_at: null, person_id, person_name: null });
  it('the same thing for the same person', () => {
    const open = [task('t1', 'Send Jordan the onboarding deck', 'p1'), task('t2', 'Renew passport', null)];
    expect(findDuplicateTask({ text: 'Send the onboarding deck', person_id: 'p1' }, open)?.id).toBe('t1');
    expect(findDuplicateTask({ text: 'Send the onboarding deck', person_id: 'p2' }, open)).toBeNull();
    expect(findDuplicateTask({ text: 'passport renewal', person_id: null }, open)?.id).toBe('t2');
    expect(findDuplicateTask({ text: 'Renew my passport', person_id: null }, open)?.id).toBe('t2');
    // Tasks lead with verbs: a shared "renew" alone isn't the same task.
    expect(findDuplicateTask({ text: 'Renew car insurance', person_id: null }, open)).toBeNull();
  });
});
