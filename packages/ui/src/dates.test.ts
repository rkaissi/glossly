import { describe, expect, it } from 'vitest';
import { appName, firstName, formatDay, formatDue } from './dates';

// Saturday, Oct 10 2026, 2 PM local.
const now = new Date(2026, 9, 10, 14, 0);

describe('dates', () => {
  it('formats days relative to today', () => {
    expect(formatDay('2026-10-10', now)).toBe('Today');
    expect(formatDay('2026-10-11T09:00:00-04:00', now)).toBe('Tomorrow');
    expect(formatDay('2026-10-09', now)).toBe('Yesterday');
    expect(formatDay('2026-10-16', now)).toBe('Fri');
    expect(formatDay('2026-10-17', now)).toBe('Oct 17');
    expect(formatDay('2027-01-05', now)).toBe('Jan 5, 2027');
    expect(formatDay('nonsense', now)).toBe('');
  });

  it('formats due dates and flags overdue ones', () => {
    expect(formatDue(null, now)).toEqual({ label: 'No date', overdue: false });
    expect(formatDue('2026-10-10', now)).toEqual({ label: 'Due today', overdue: false });
    expect(formatDue('2026-10-16T15:00:00-04:00', now)).toEqual({ label: 'Due Fri 3 PM', overdue: false });
    expect(formatDue('2026-10-11T09:30:00-04:00', now).label).toBe('Due tomorrow 9:30 AM');
    expect(formatDue('2026-10-02', now)).toEqual({ label: 'Overdue: Oct 2', overdue: true });
  });

  it('names apps and first names', () => {
    expect(appName('slack.exe')).toBe('Slack');
    expect(appName(null)).toBe('');
    expect(firstName('  Sam Lee ')).toBe('Sam');
  });
});
