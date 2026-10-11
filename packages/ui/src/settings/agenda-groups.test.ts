import { describe, expect, it } from 'vitest';
import type { CalendarEvent, CommitmentView } from '@glossly/core/api';
import { groupAgenda } from './agenda-groups';

// Wednesday, Oct 14 2026, 10:00 local.
const now = new Date(2026, 9, 14, 10, 0);
const task = (id: string, due_at: string | null): CommitmentView => ({ id, owner: 'me', text: id, due_at, status: 'open', person_id: null, person_name: null });
const event = (id: string, starts_at: string, all_day = false): CalendarEvent => ({
  id,
  title: id,
  starts_at,
  ends_at: null,
  all_day,
  location: null,
  attendees: [],
  people: [],
  source_app: null,
  created_at: '2026-10-01T00:00:00Z',
});

describe('groupAgenda', () => {
  it('puts tasks and events into day groups, all-day first within a day', () => {
    const groups = groupAgenda(
      [task('late', '2026-10-12'), task('today task', '2026-10-14'), task('someday', null), task('next month', '2026-11-20')],
      [event('lunch', '2026-10-14T13:00:00-04:00'), event('offsite', '2026-10-15', true), event('call', '2026-10-15T09:00:00-04:00'), event('past', '2026-10-13T09:00:00-04:00'), event('sat', '2026-10-17T10:00:00-04:00')],
      now,
    );
    expect(groups.map((g) => [g.label, g.entries.map((e) => (e.kind === 'task' ? e.task.id : e.event.id))])).toEqual([
      ['Overdue', ['late']],
      ['Today', ['today task', 'lunch']],
      ['Tomorrow', ['offsite', 'call']],
      ['This week', ['sat']],
      ['Later', ['next month']],
      ['No date', ['someday']],
    ]);
  });

  it('returns no groups when there is nothing', () => {
    expect(groupAgenda([], [], now)).toEqual([]);
  });
});
