import { describe, expect, it } from 'vitest';
import { isoNow } from '../types';
import { resolveEventTime, splitRange } from './when';

// Wednesday, Oct 14 2026, 10:00 local.
const now = new Date(2026, 9, 14, 10, 0);
const at = (d: number, h: number, m = 0) => isoNow(new Date(2026, 9, d, h, m));

describe('splitRange', () => {
  it('splits time ranges and shares am or pm', () => {
    expect(splitRange('Thursday 1-2pm')).toEqual({ start: 'Thursday 1pm', end: '2pm' });
    expect(splitRange('tomorrow 11-1pm')).toEqual({ start: 'tomorrow 11am', end: '1pm' });
    expect(splitRange('Friday 9:30 to 10:15')).toEqual({ start: 'Friday 9:30', end: '10:15' });
    expect(splitRange('12-1pm on Monday')).toEqual({ start: '12pm on Monday', end: '1pm' });
  });

  it('leaves dates and single times alone', () => {
    expect(splitRange('10-14')).toEqual({ start: '10-14', end: null });
    expect(splitRange('Thursday 1pm')).toEqual({ start: 'Thursday 1pm', end: null });
  });
});

describe('resolveEventTime', () => {
  it('reads a day and time, with an hour by default', () => {
    expect(resolveEventTime({ when: 'Thursday 1pm' }, now)).toEqual({ starts_at: at(15, 13), ends_at: at(15, 14), all_day: false });
  });

  it('reads ranges, end times, and lengths', () => {
    expect(resolveEventTime({ when: 'Thursday 1-2:30pm' }, now)).toMatchObject({ starts_at: at(15, 13), ends_at: at(15, 14, 30) });
    expect(resolveEventTime({ when: 'Friday at 2', end: '4' }, now)).toMatchObject({ starts_at: at(16, 14), ends_at: at(16, 16) });
    expect(resolveEventTime({ when: 'tomorrow 9am', minutes: 30 }, now)).toMatchObject({ starts_at: at(15, 9), ends_at: at(15, 9, 30) });
    // An end before the start is ignored.
    expect(resolveEventTime({ when: 'tomorrow 3pm', end: '1pm' }, now)).toMatchObject({ ends_at: at(15, 16) });
  });

  it('makes a day without a time all day, and gives up on no day', () => {
    expect(resolveEventTime({ when: 'Oct 20' }, now)).toEqual({ starts_at: '2026-10-20', ends_at: null, all_day: true });
    expect(resolveEventTime({ when: 'sometime soon' }, now)).toBeNull();
    expect(resolveEventTime({ when: '' }, now)).toBeNull();
  });
});
