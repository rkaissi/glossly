import { describe, expect, it } from 'vitest';
import { durationLabel, eventSpan, layoutDay, monthDays, rangeDays, shiftRange, snapMinutes, tint, toClock, weekTitle } from './calendar-logic';

describe('event spans', () => {
  it('reads times as written', () => {
    expect(eventSpan({ starts_at: '2026-10-15T10:00:00+02:00', ends_at: '2026-10-15T11:30:00+02:00' })).toEqual({ start: 600, end: 690 });
  });
  it('makes a missing end an hour, a next-day end midnight, and short events 15 minutes', () => {
    expect(eventSpan({ starts_at: '2026-10-15T23:30:00+02:00', ends_at: null })).toEqual({ start: 1410, end: 1440 });
    expect(eventSpan({ starts_at: '2026-10-15T22:00:00+02:00', ends_at: '2026-10-16T01:00:00+02:00' })).toEqual({ start: 1320, end: 1440 });
    expect(eventSpan({ starts_at: '2026-10-15T09:00:00+02:00', ends_at: '2026-10-15T09:05:00+02:00' })).toEqual({ start: 540, end: 555 });
  });
});

describe('week layout', () => {
  it('gives events that do not overlap the full width', () => {
    const l = layoutDay([
      { id: 'a', start: 540, end: 600 },
      { id: 'b', start: 600, end: 660 },
    ]);
    expect(l.get('a')).toEqual({ col: 0, cols: 1 });
    expect(l.get('b')).toEqual({ col: 0, cols: 1 });
  });
  it('splits overlapping events into columns and reuses a free one', () => {
    const l = layoutDay([
      { id: 'long', start: 540, end: 720 },
      { id: 'x', start: 570, end: 630 },
      { id: 'y', start: 640, end: 700 },
      { id: 'z', start: 600, end: 660 },
      { id: 'after', start: 800, end: 860 },
    ]);
    expect(l.get('long')).toEqual({ col: 0, cols: 3 });
    expect(l.get('x')).toEqual({ col: 1, cols: 3 });
    expect(l.get('z')).toEqual({ col: 2, cols: 3 });
    expect(l.get('y')).toEqual({ col: 1, cols: 3 });
    expect(l.get('after')).toEqual({ col: 0, cols: 1 });
  });
});

describe('drags and labels', () => {
  it('snaps to 15 minutes inside the day', () => {
    expect(snapMinutes(0, 48)).toBe(0);
    expect(snapMinutes(48 * 10 + 5, 48)).toBe(600);
    expect(snapMinutes(48 * 10 + 7, 48)).toBe(615);
    expect(snapMinutes(-20, 48)).toBe(0);
    expect(snapMinutes(48 * 25, 48)).toBe(1440);
    expect(toClock(615)).toBe('10:15');
    expect([30, 60, 90].map(durationLabel)).toEqual(['30 min', '1 h', '1 h 30 min']);
  });
  it('titles weeks', () => {
    expect(weekTitle('2026-10-12', '2026-10-14')).toBe('Oct 12 – 18');
    expect(weekTitle('2026-09-28', '2026-10-14')).toBe('Sep 28 – Oct 4');
    expect(weekTitle('2026-12-28', '2026-10-14')).toBe('Dec 28 – Jan 3, 2027');
  });
  it('picks a steady tint per event', () => {
    expect(tint('e1')).toBe(tint('e1'));
    expect(new Set(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map(tint)).size).toBeGreaterThan(1);
  });
});

describe('month and ranges', () => {
  it('shows whole weeks through the end of the month', () => {
    const oct = monthDays('2026-10-14');
    expect(oct[0]).toBe('2026-09-28');
    expect(oct.length).toBe(35);
    expect(oct[34]).toBe('2026-11-01');
    expect(monthDays('2027-02-10')).toHaveLength(28); // Feb 2027 starts on a Monday and has 28 days
    expect(monthDays('2026-10-14', 0)[0]).toBe('2026-09-27');
  });
  it('lists and moves ranges', () => {
    expect(rangeDays({ from: '2026-10-30', to: '2026-11-02' })).toEqual(['2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02']);
    expect(shiftRange({ from: '2026-10-14', to: '2026-10-27' }, 1)).toEqual({ from: '2026-10-28', to: '2026-11-10' });
    expect(shiftRange({ from: '2026-10-14', to: '2026-10-14' }, -1)).toEqual({ from: '2026-10-13', to: '2026-10-13' });
  });
});
