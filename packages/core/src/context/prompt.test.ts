import { describe, expect, it } from 'vitest';
import { isoNow } from '../types';
import { contextUsed, dayLabel, eventLabel, taskLabel, taskOwner } from './prompt';

// Wednesday, Oct 14 2026, 10 am.
const NOW = new Date(2026, 9, 14, 10);
const at = (d: number, h: number, m = 0) => isoNow(new Date(2026, 9, d, h, m));
// The labels must use plain spaces (Intl writes a narrow no-break one before AM and PM): no normalizing here.
const plain = (s: string) => s;

describe('date labels', () => {
  it('names days relative to today', () => {
    expect(dayLabel(new Date(2026, 9, 14, 23), NOW)).toBe('today');
    expect(dayLabel(new Date(2026, 9, 15, 1), NOW)).toBe('tomorrow');
    expect(dayLabel(new Date(2026, 9, 13, 8), NOW)).toBe('yesterday');
    expect(dayLabel(new Date(2026, 9, 16), NOW)).toBe('Fri, Oct 16 (in 2 days)');
    expect(dayLabel(new Date(2026, 9, 10), NOW)).toBe('Sat, Oct 10 (4 days ago)');
  });

  it('says whether an event is coming, happening, or past', () => {
    const ev = (s: string, e: string | null, all_day = false) => plain(eventLabel({ starts_at: s, ends_at: e, all_day }, NOW));
    expect(ev(at(14, 13), at(14, 17))).toBe('today, 1:00 PM to 5:00 PM, in 3 hours');
    expect(ev(at(14, 10, 40), null)).toBe('today, 10:40 AM, in 40 minutes');
    expect(ev(at(14, 9), at(14, 11))).toBe('today, 9:00 AM to 11:00 AM, happening now');
    expect(ev(at(13, 15), at(13, 16))).toBe('yesterday, 3:00 PM to 4:00 PM, past');
    expect(ev(at(14, 8), null)).toBe('today, 8:00 AM, past');
    expect(ev(at(15, 22), at(16, 2))).toBe('tomorrow, 10:00 PM to Fri, Oct 16 (in 2 days) 2:00 AM');
    expect(ev('2026-10-17', null, true)).toBe('Sat, Oct 17 (in 3 days), all day');
    expect(ev('2026-10-12', null, true)).toBe('Mon, Oct 12 (2 days ago), all day, past');
  });

  it("gives a task's state and how its due date stands", () => {
    const t = (status: 'open' | 'done' | 'dropped', due_at: string | null, completed_at: string | null = null) => plain(taskLabel({ status, due_at, completed_at }, NOW));
    expect(t('open', null)).toBe('open');
    expect(t('open', '2026-10-15')).toBe('open, due tomorrow');
    expect(t('open', at(14, 17))).toBe('open, due today at 5:00 PM');
    expect(t('open', '2026-10-13')).toBe('open, overdue by 1 day (was due Oct 13)');
    expect(t('done', '2026-10-13', at(13, 18))).toBe('done Oct 13');
    expect(t('dropped', null)).toBe('dropped');
  });

  it('says who owes whom', () => {
    expect(taskOwner({ owner: 'me', person_name: 'Jordan Hale' })).toBe('The user owes Jordan Hale');
    expect(taskOwner({ owner: 'them', person_name: 'Jordan Hale' })).toBe('Jordan Hale owes the user');
    expect(taskOwner({ owner: 'me', person_name: null })).toBe("The user's own task");
  });
});

describe('contextUsed', () => {
  it('lists notes, then people, tasks, and events, with short labels', () => {
    const used = contextUsed(
      {
        people: [{ id: 'p', name: 'Casey Lin', relationship: 'friend', note: null, reason: 'named', similarity: null }],
        tasks: [{ id: 't', owner: 'me', text: 'Pay Casey back', due_at: '2026-10-15', status: 'open', completed_at: null, person_id: 'p', person_name: 'Casey Lin', reason: 'person', similarity: null }],
        events: [],
      },
      [{ id: 'n', text: `Casey is vegetarian. ${'More. '.repeat(30)}` }],
      NOW,
    );
    expect(used.map((u) => [u.kind, u.id, u.detail])).toEqual([
      ['note', 'n', null],
      ['person', 'p', 'friend'],
      ['task', 't', 'open, due tomorrow'],
    ]);
    expect(used[0]!.label.length).toBeLessThanOrEqual(90);
  });
});
