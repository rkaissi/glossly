import { describe, expect, it } from 'vitest';
import { isoNow } from '../types';
import { resolveDue } from './dates';

// Wednesday, Oct 14 2026, 10:00 local. Expected times are built in local time too, so the
// tests pass in any time zone.
const now = new Date(2026, 9, 14, 10, 0);
const at = (m: number, d: number, h: number, min = 0, y = 2026) => isoNow(new Date(y, m - 1, d, h, min));

const CASES: [string, string | null][] = [
  ['today', '2026-10-14'],
  ['Tomorrow', '2026-10-15'],
  ['tonight', at(10, 14, 20)],
  ['tomorrow 3pm', at(10, 15, 15)],
  ['tomorrow at 10:30am', at(10, 15, 10, 30)],
  ['tomorrow morning', at(10, 15, 9)],
  ['the day after tomorrow', '2026-10-16'],
  ['Friday', '2026-10-16'],
  ['by Friday', '2026-10-16'],
  ['before Friday', '2026-10-16'],
  ['Fri', '2026-10-16'],
  ['friday 3pm', at(10, 16, 15)],
  ['Friday at 3', at(10, 16, 15)],
  ['Friday at 10', at(10, 16, 10)],
  ['friday afternoon', at(10, 16, 14)],
  ['Wednesday', '2026-10-14'],
  ['Monday', '2026-10-19'],
  ['this Friday', '2026-10-16'],
  ['next Friday', '2026-10-23'],
  ['next Monday', '2026-10-19'],
  ['next Wednesday', '2026-10-21'],
  ['end of week', at(10, 16, 17)],
  ['end of the week', at(10, 16, 17)],
  ['EOW', at(10, 16, 17)],
  ['end of next week', at(10, 23, 17)],
  ['end of month', '2026-10-31'],
  ['end of the month', '2026-10-31'],
  ['end of day', at(10, 14, 17)],
  ['by EOD', at(10, 14, 17)],
  // Step 21's Tasks eval: the end of a named day.
  ['end of day tomorrow', at(10, 15, 17)],
  ['by end of day Friday', at(10, 16, 17)],
  ['Friday end of day', at(10, 16, 17)],
  ['next week', '2026-10-19'],
  ['next month', '2026-11-01'],
  ['in 2 days', '2026-10-16'],
  ['in a week', '2026-10-21'],
  ['in two weeks', '2026-10-28'],
  ['in a couple of days', '2026-10-16'],
  ['Oct 20', '2026-10-20'],
  ['October 20th', '2026-10-20'],
  ['20 Oct', '2026-10-20'],
  ['the 20th of October', '2026-10-20'],
  ['Tuesday, Oct 20', '2026-10-20'],
  ['Oct 20 at 2pm', at(10, 20, 14)],
  ['the 20th', '2026-10-20'],
  ['the 5th', '2026-11-05'],
  ['10/20', '2026-10-20'],
  ['10/20/2027', '2027-10-20'],
  ['2026-12-01', '2026-12-01'],
  ['Jan 5', '2027-01-05'],
  ['Oct 10', '2026-10-10'],
  ['Sep 1', '2027-09-01'],
  ['3pm', at(10, 14, 15)],
  ['9am', at(10, 15, 9)],
  ['noon', at(10, 14, 12)],
  ['this afternoon', at(10, 14, 14)],
  ['Feb 30', null],
  ['asap', null],
  ['soon', null],
  ['next sprint', null],
  ['', null],
];

describe('resolveDue', () => {
  it.each(CASES)('%s', (phrase, expected) => {
    expect(resolveDue(phrase, now)).toBe(expected);
  });

  it('rolls end of week and next weekday forward on a weekend', () => {
    const saturday = new Date(2026, 9, 17, 11, 0);
    expect(resolveDue('end of week', saturday)).toBe(at(10, 23, 17));
    expect(resolveDue('next Friday', saturday)).toBe('2026-10-23');
    expect(resolveDue('Friday', saturday)).toBe('2026-10-23');
  });

  it('handles null and month ends', () => {
    expect(resolveDue(null, now)).toBeNull();
    expect(resolveDue('end of month', new Date(2026, 1, 3))).toBe('2026-02-28');
    expect(resolveDue('end of month', new Date(2026, 11, 3))).toBe('2026-12-31');
  });
});
