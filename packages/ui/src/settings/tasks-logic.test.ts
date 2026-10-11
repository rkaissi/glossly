import { describe, expect, it } from 'vitest';
import type { CommitmentView } from '@glossly/core/api';
import { doneLabel, matchesFilter, readDue, relDay, taskSections, withoutDue } from './tasks-logic';

const task = (id: string, due_at: string | null, extra: Partial<CommitmentView> = {}): CommitmentView => ({
  id,
  owner: 'me',
  text: id,
  due_at,
  status: 'open',
  completed_at: null,
  person_id: null,
  person_name: null,
  ...extra,
});
const TODAY = '2026-10-14'; // a Wednesday

describe('filters', () => {
  const owe = task('a', null, { person_id: 'p1', person_name: 'Jordan Hale' });
  const owed = task('b', null, { owner: 'them', person_id: 'p1', person_name: 'Jordan Hale' });
  const todo = task('c', null);
  it('splits You owe, They owe, and Todos', () => {
    expect([owe, owed, todo].map((t) => matchesFilter(t, 'me'))).toEqual([true, false, false]);
    expect([owe, owed, todo].map((t) => matchesFilter(t, 'them'))).toEqual([false, true, false]);
    expect([owe, owed, todo].map((t) => matchesFilter(t, 'todo'))).toEqual([false, false, true]);
    expect([owe, owed, todo].every((t) => matchesFilter(t, 'all'))).toBe(true);
  });
});

describe('sections', () => {
  it('groups open tasks by when they are due', () => {
    const s = taskSections(
      [task('later', '2026-10-16'), task('none', null), task('old', '2026-10-10'), task('older', '2026-10-01'), task('today', '2026-10-14T15:00:00+02:00'), task('later2', '2026-10-16')],
      TODAY,
    );
    expect(s.overdue.map((t) => t.id)).toEqual(['older', 'old']);
    expect(s.today.map((t) => t.id)).toEqual(['today']);
    expect(s.days).toEqual([{ day: '2026-10-16', tasks: [expect.objectContaining({ id: 'later' }), expect.objectContaining({ id: 'later2' })] }]);
    expect(s.noDate.map((t) => t.id)).toEqual(['none']);
  });
});

describe('labels', () => {
  it('says days relative to today', () => {
    expect(relDay('2026-10-14', TODAY)).toBe('Today');
    expect(relDay('2026-10-15', TODAY)).toBe('Tomorrow');
    expect(relDay('2026-10-13', TODAY)).toBe('Yesterday');
    expect(relDay('2026-10-11', TODAY)).toBe('3 days ago');
    expect(relDay('2026-10-17', TODAY)).toBe('Saturday');
    expect(relDay('2026-10-30', TODAY)).toBe('Oct 30');
    expect(relDay('2027-01-05', TODAY)).toBe('Jan 5, 2027');
  });
  it('says when a task was done', () => {
    expect(doneLabel(null, TODAY)).toBe('Done');
    expect(doneLabel(new Date(2026, 9, 14, 9).toISOString(), TODAY)).toBe('Done today');
    expect(doneLabel(new Date(2026, 9, 13, 20).toISOString(), TODAY)).toBe('Done yesterday');
    expect(doneLabel(new Date(2026, 9, 2, 12).toISOString(), TODAY)).toBe('Done Oct 2');
  });
});

describe('quick add dates', () => {
  it.each([
    ['Send Maya the invoice tomorrow', '2026-10-15', 'Send Maya the invoice'],
    ['Send Maya the invoice by Friday', '2026-10-16', 'Send Maya the invoice'],
    ['Call the dentist today', '2026-10-14', 'Call the dentist'],
    ['Book flights next week', '2026-10-19', 'Book flights'],
    ['On Monday, file the report', '2026-10-19', 'File the report'],
    ['Review the deck due Wednesday', '2026-10-21', 'Review the deck'],
    ['Plan the offsite next friday', '2026-10-23', 'Plan the offsite'],
    ['Water the plants this saturday', '2026-10-17', 'Water the plants'],
  ])('reads %j', (text, day, title) => {
    const found = readDue(text, TODAY);
    expect(found?.day).toBe(day);
    expect(withoutDue(text, found!)).toBe(title);
  });
  it('leaves text with no date alone, and never empties a title', () => {
    expect(readDue('Renew passport', TODAY)).toBeNull();
    expect(readDue('Mondays are slow', TODAY)).toBeNull();
    expect(withoutDue('Tomorrow', readDue('Tomorrow', TODAY)!)).toBe('Tomorrow');
  });
  it('follows the week start for next week', () => {
    expect(readDue('next week', TODAY, 0)?.day).toBe('2026-10-18');
  });
});
