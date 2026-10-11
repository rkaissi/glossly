import { afterEach, describe, expect, it } from 'vitest';
import { PeopleRepo } from '../store/people';
import { Store } from '../store/store';
import { isoNow } from '../types';
import { isEventSentence, rulesEvents, toEventRows, type ExtractedEvent } from './events';

// Wednesday, Oct 14 2026, 10:00 local.
const now = new Date(2026, 9, 14, 10, 0);
const at = (d: number, h: number, m = 0) => isoNow(new Date(2026, 9, d, h, m));

let store: Store | null = null;
afterEach(() => {
  store?.close();
  store = null;
});

const ev = (over: Partial<ExtractedEvent>): ExtractedEvent => ({ title: 'Lunch', when: '', end: '', duration_minutes: 0, location: '', people: [], confidence: 0.9, ...over });

describe('isEventSentence', () => {
  it('needs a day and a meeting word, or a day and a time without deadline words', () => {
    expect(isEventSentence('Lunch Thursday?')).toBe(true);
    expect(isEventSentence('Call Thursday at 2pm')).toBe(true);
    expect(isEventSentence('See you Friday at 10:30')).toBe(true);
    expect(isEventSentence('Can you review the deck by Friday?')).toBe(false);
    expect(isEventSentence('Send it by Friday 5pm')).toBe(false);
    expect(isEventSentence('Lunch was great')).toBe(false);
  });
});

describe('rulesEvents', () => {
  it('titles by the meeting word and the author, and finds the place', () => {
    const out = rulesEvents('Lunch Thursday at 1pm at Northwind Cafe? Also can you bring the deck.', { name: 'Jordan Hale', isMe: false });
    expect(out).toEqual([
      { title: 'Lunch with Jordan', when: 'Thursday 1pm', end: '', duration_minutes: 0, location: 'Northwind Cafe', people: ['Jordan Hale'], confidence: 0.6 },
    ]);
  });

  it('keeps ranges for the resolver and leaves out days as places', () => {
    const [e] = rulesEvents('Design review on Friday 2-3pm in Room 4', { name: null, isMe: true });
    expect(e).toMatchObject({ title: 'Review', when: 'Friday 2-3pm', location: 'Room 4', people: [] });
    expect(rulesEvents('Coffee at Monday 9am', { name: null, isMe: true })[0]!.location).toBe('');
  });
});

describe('toEventRows', () => {
  it('resolves times, matches saved people exactly, and drops duplicates', () => {
    store = new Store(':memory:');
    const people = new PeopleRepo(store);
    const jordan = people.create({ name: 'Jordan Hale' });
    const rows = toEventRows(
      [
        ev({ title: 'Lunch with Jordan', when: 'Thursday 1-2pm', location: 'Northwind Cafe', people: ['Jordan Hale', 'Casey Lin'] }),
        ev({ title: 'Lunch with  Jordan', when: 'Thursday 1pm' }),
        ev({ title: 'Offsite', when: 'Oct 20', confidence: 85 }),
        ev({ title: 'Someday drinks', when: 'sometime' }),
      ],
      people,
      'slack.exe',
      now,
    );
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({
      starts_at: at(15, 13),
      ends_at: at(15, 14),
      all_day: false,
      attendees: ['Jordan Hale', 'Casey Lin'],
      people: [{ personId: jordan.id, name: 'Jordan Hale' }],
      selected: true,
    });
    expect(rows[1]).toMatchObject({ title: 'Offsite', starts_at: '2026-10-20', all_day: true, confidence: 0.85 });
    // No readable day: offered unchecked for the user to pick one.
    expect(rows[2]).toMatchObject({ title: 'Someday drinks', starts_at: null, selected: false });
  });
});
