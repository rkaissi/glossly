import { afterEach, describe, expect, it } from 'vitest';
import { isoNow } from '../types';
import { CalendarRepo } from './calendar';
import { PeopleRepo } from './people';
import { Store } from './store';

let store: Store | null = null;
afterEach(() => {
  store?.close();
  store = null;
});

const at = (d: number, h: number, m = 0) => isoNow(new Date(2026, 9, d, h, m));
const lunch = (personIds: string[] = []) => ({
  title: '  Lunch   with Jordan ',
  starts_at: at(15, 13),
  ends_at: at(15, 14),
  all_day: false,
  location: 'Northwind Cafe',
  attendees: ['Jordan Hale', 'Casey Lin'],
  personIds,
});

function setup() {
  store = new Store(':memory:');
  // Wednesday, Oct 14 2026: the card's "coming up" counts from here.
  return { calendar: new CalendarRepo(store), people: new PeopleRepo(store, () => at(14, 10)) };
}

describe('CalendarRepo', () => {
  it('adds an event with its saved people, and lists by day, person, and words', () => {
    const { calendar, people } = setup();
    const jordan = people.create({ name: 'Jordan Hale' });
    const e = calendar.add(lunch([jordan.id, 'missing']), 'slack.exe');
    expect(e).toMatchObject({ title: 'Lunch with Jordan', all_day: false, location: 'Northwind Cafe', attendees: ['Jordan Hale', 'Casey Lin'], people: [{ id: jordan.id, name: 'Jordan Hale' }] });
    calendar.add({ title: 'Offsite', starts_at: '2026-10-20', ends_at: at(20, 18), all_day: true, location: null, attendees: [], personIds: [] }, null);

    expect(calendar.list().map((x) => x.title)).toEqual(['Lunch with Jordan', 'Offsite']);
    // An all-day event keeps no end.
    expect(calendar.list({ from: '2026-10-20' })[0]).toMatchObject({ starts_at: '2026-10-20', ends_at: null, all_day: true });
    expect(calendar.list({ to: '2026-10-15' }).map((x) => x.title)).toEqual(['Lunch with Jordan']);
    expect(calendar.list({ personId: jordan.id })).toHaveLength(1);
    expect(calendar.list({ query: 'northwind' })).toHaveLength(1);
    expect(calendar.list({ query: 'casey' })).toHaveLength(1);
    expect(calendar.list({ query: '100%' })).toHaveLength(0);
    // The person's card shows it while it is ahead.
    expect(people.card(jordan.id)!.events.map((x) => x.title)).toEqual(['Lunch with Jordan']);
  });

  it('edits, deletes, and follows people through merges and deletes', () => {
    const { calendar, people } = setup();
    const a = people.create({ name: 'Jordan Hale' });
    const b = people.create({ name: 'J. Hale' });
    const e = calendar.add(lunch([b.id]), null);
    calendar.update(e.id, { title: 'Lunch', starts_at: at(16, 12), ends_at: at(16, 13) });
    expect(calendar.get(e.id)).toMatchObject({ title: 'Lunch', starts_at: at(16, 12) });
    expect(() => calendar.update(e.id, { title: '  ' })).toThrow();

    people.merge(a.id, b.id);
    expect(calendar.get(e.id)!.people.map((p) => p.id)).toEqual([a.id]);
    people.delete(a.id);
    expect(calendar.get(e.id)!.people).toEqual([]);

    calendar.delete(e.id);
    expect(calendar.get(e.id)).toBeNull();
  });

  it('finds reminders: timed events from the lead time until they end, all-day ones on their day', () => {
    const { calendar } = setup();
    const timed = calendar.add(lunch(), null);
    const allDay = calendar.add({ title: 'Offsite', starts_at: '2026-10-15', ends_at: null, all_day: true, location: null, attendees: [], personIds: [] }, null);
    const ids = (now: Date, cutoff: string) => calendar.dueReminders(now, 15, cutoff).map((e) => e.id);

    expect(ids(new Date(2026, 9, 15, 8, 0), '2026-10-14')).toEqual([]);
    // From the reminder hour, the all-day event's day counts.
    expect(ids(new Date(2026, 9, 15, 9, 0), '2026-10-15')).toEqual([allDay.id]);
    expect(ids(new Date(2026, 9, 15, 12, 46), '2026-10-15')).toEqual([allDay.id, timed.id]);
    calendar.markNotified(timed.id);
    expect(ids(new Date(2026, 9, 15, 12, 50), '2026-10-15')).toEqual([allDay.id]);
    // Moving an event brings its reminder back; an event that ended is not reminded.
    calendar.update(timed.id, { starts_at: at(16, 13), ends_at: at(16, 14) });
    expect(ids(new Date(2026, 9, 16, 14, 30), '2026-10-16')).toEqual([]);
    expect(ids(new Date(2026, 9, 16, 12, 50), '2026-10-16')).toEqual([timed.id]);
  });
});
