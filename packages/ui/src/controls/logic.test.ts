import { describe, expect, it } from 'vitest';
import {
  addDays,
  addMinutes,
  addMonths,
  diffDays,
  anchorHidden,
  dateShortcuts,
  formatTime,
  isDay,
  menuMove,
  monthGrid,
  nearestStep,
  ordered,
  parseTime,
  placePopover,
  quickRanges,
  rangeLabel,
  rangeRole,
  roomNeeded,
  TIME_STEPS,
  typeAhead,
  weekdayNames,
  weekStart,
} from './logic';

const rect = (top: number, left: number, h = 32, w = 160) => ({ top, left, bottom: top + h, right: left + w });
const VIEW = { w: 1000, h: 800 };

describe('placePopover', () => {
  it('goes below the anchor when it fits', () => {
    expect(placePopover(rect(100, 50), { w: 250, h: 300 }, VIEW)).toEqual({ top: 138, left: 50, maxHeight: null, side: 'below' });
  });
  it('flips above when below is too short and above fits', () => {
    const p = placePopover(rect(600, 50), { w: 250, h: 300 }, VIEW);
    expect(p).toEqual({ top: 600 - 6 - 300, left: 50, maxHeight: null, side: 'above' });
  });
  it('caps the height on the roomier side when neither fits', () => {
    const p = placePopover(rect(300, 50), { w: 250, h: 700 }, { w: 1000, h: 700 });
    // below: 700 - 8 - 338 = 354; above: 300 - 14 = 286
    expect(p).toEqual({ top: 338, left: 50, maxHeight: 354, side: 'below' });
    const q = placePopover(rect(500, 50), { w: 250, h: 700 }, { w: 1000, h: 700 });
    expect(q.side).toBe('above');
    expect(q.maxHeight).toBe(486);
    expect(q.top).toBe(8);
  });
  it('aligns to the right edge for end, and stays inside the window', () => {
    expect(placePopover(rect(100, 800), { w: 250, h: 100 }, VIEW, 'end').left).toBe(800 + 160 - 250);
    expect(placePopover(rect(100, 900), { w: 250, h: 100 }, VIEW).left).toBe(1000 - 250 - 8);
    expect(placePopover(rect(100, -40), { w: 250, h: 100 }, VIEW).left).toBe(8);
  });
  it('goes beside an anchor for side placement', () => {
    expect(placePopover(rect(200, 100), { w: 300, h: 400 }, VIEW, 'side')).toEqual({ top: 200, left: 266, maxHeight: null, side: 'below' });
    // no room on the right: to the left
    expect(placePopover(rect(200, 700, 32, 200), { w: 300, h: 400 }, VIEW, 'side').left).toBe(394);
    // near the bottom: moved up to fit
    expect(placePopover(rect(700, 100), { w: 300, h: 400 }, VIEW, 'side').top).toBe(392);
  });
  it('reports the room a popover below needs, and when the anchor is scrolled away', () => {
    expect(roomNeeded(rect(100, 0), 300, 600)).toBeNull(); // fits below
    expect(roomNeeded(rect(500, 0), 300, 600)).toBeNull(); // fits above
    expect(roomNeeded(rect(100, 0), 300, 200)).toEqual({ below: 132 + 6 + 300 + 8, above: 200 - 100 + 6 + 300 + 8 });
    expect(anchorHidden(rect(10, 0), { top: 50, bottom: 400, left: 0, right: 0 })).toBe(true);
    expect(anchorHidden(rect(30, 0), { top: 50, bottom: 400, left: 0, right: 0 })).toBe(false);
    expect(anchorHidden(rect(401, 0), { top: 50, bottom: 400, left: 0, right: 0 })).toBe(true);
  });
});

describe('menu keys', () => {
  const none = [false, false, false, false];
  it('moves and wraps', () => {
    expect(menuMove('ArrowDown', 0, none)).toBe(1);
    expect(menuMove('ArrowDown', 3, none)).toBe(0);
    expect(menuMove('ArrowUp', 0, none)).toBe(3);
    expect(menuMove('ArrowDown', -1, none)).toBe(0);
    expect(menuMove('ArrowUp', -1, none)).toBe(3);
    expect(menuMove('Home', 2, none)).toBe(0);
    expect(menuMove('End', 0, none)).toBe(3);
    expect(menuMove('x', 0, none)).toBeNull();
  });
  it('skips disabled items', () => {
    const d = [true, false, true, false];
    expect(menuMove('ArrowDown', 1, d)).toBe(3);
    expect(menuMove('ArrowDown', 3, d)).toBe(1);
    expect(menuMove('Home', 3, d)).toBe(1);
    expect(menuMove('ArrowDown', -1, [true, true])).toBe(-1);
  });
  it('type-ahead adds keys within 600 ms and starts over after', () => {
    const labels = ['Alex Morgan', 'Casey Lin', 'Casey Moss', 'Jordan Hale'];
    const off = labels.map(() => false);
    let s = typeAhead({ typed: '', at: 0 }, 'c', 1000, labels, off);
    expect(s.index).toBe(1);
    s = typeAhead(s, 'a', 1200, labels, off);
    expect(s).toMatchObject({ typed: 'ca', index: 1 });
    s = typeAhead(s, 'j', 2000, labels, off);
    expect(s).toMatchObject({ typed: 'j', index: 3 });
    expect(typeAhead({ typed: '', at: 0 }, 'z', 1, labels, off).index).toBeNull();
    expect(typeAhead({ typed: '', at: 0 }, 'a', 1, labels, [true, false, false, false]).index).toBeNull();
  });
});

describe('days', () => {
  it('does day arithmetic across months and years', () => {
    expect(addDays('2026-10-31', 1)).toBe('2026-11-01');
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31');
    expect(addMonths('2026-12-15', 1)).toBe('2027-01-01');
    expect(addMonths('2026-03-31', -1)).toBe('2026-02-01');
    expect(isDay('2026-02-29')).toBe(false);
    expect(isDay('2028-02-29')).toBe(true);
    expect(isDay('2026-1-01')).toBe(false);
  });
  it('starts weeks on Monday', () => {
    expect(weekStart('2026-10-11')).toBe('2026-10-05'); // a Sunday
    expect(weekStart('2026-10-12')).toBe('2026-10-12'); // a Monday
  });
  it('starts weeks on Sunday when set', () => {
    expect(weekStart('2026-10-11', 0)).toBe('2026-10-11'); // a Sunday
    expect(weekStart('2026-10-14', 0)).toBe('2026-10-11');
    expect(monthGrid('2026-10-11', 0)[0]).toBe('2026-09-27');
    expect(weekdayNames(0)[0]).toBe('Sun');
    expect(weekdayNames()).toEqual(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']);
    expect(diffDays('2026-11-01', '2026-10-30')).toBe(2);
    expect(diffDays('2026-03-01', '2026-03-31')).toBe(-30);
  });
  it('draws six weeks from the Monday on or before the 1st', () => {
    const g = monthGrid('2026-10-11');
    expect(g).toHaveLength(42);
    expect(g[0]).toBe('2026-09-28');
    expect(g[3]).toBe('2026-10-01');
    expect(g[41]).toBe('2026-11-08');
  });
  it('offers Today, Tomorrow, next Monday, and No date', () => {
    const s = dateShortcuts('2026-10-11');
    expect(s.map((x) => x.day)).toEqual(['2026-10-11', '2026-10-12', '2026-10-12', null]);
    expect(s[0]!.hint).toBe('Sun');
    expect(dateShortcuts('2026-10-14')[2]!.day).toBe('2026-10-19');
  });
});

describe('ranges', () => {
  it('builds quick ranges from today', () => {
    const q = Object.fromEntries(quickRanges('2026-10-14').map((r) => [r.label, r.range]));
    expect(q['This week']).toEqual({ from: '2026-10-12', to: '2026-10-18' });
    expect(q['Next week']).toEqual({ from: '2026-10-19', to: '2026-10-25' });
    expect(q['This month']).toEqual({ from: '2026-10-01', to: '2026-10-31' });
    expect(q['Next 7 days']).toEqual({ from: '2026-10-14', to: '2026-10-20' });
    expect(q['Last 7 days']).toEqual({ from: '2026-10-08', to: '2026-10-14' });
  });
  it('orders picks and marks start, end, and inside', () => {
    expect(ordered('2026-10-22', '2026-10-05')).toEqual({ from: '2026-10-05', to: '2026-10-22' });
    const r = { from: '2026-10-05', to: '2026-10-22' };
    expect(rangeRole('2026-10-05', r)).toEqual({ start: true, end: false, inside: false });
    expect(rangeRole('2026-10-10', r)).toEqual({ start: false, end: false, inside: true });
    expect(rangeRole('2026-10-22', r)).toEqual({ start: false, end: true, inside: false });
    expect(rangeRole('2026-10-23', r).inside).toBe(false);
    expect(rangeRole('2026-10-05', { from: '2026-10-05', to: '2026-10-05' })).toEqual({ start: true, end: true, inside: false });
  });
  it('labels ranges', () => {
    expect(rangeLabel({ from: '2026-10-13', to: '2026-10-19' }, '2026-10-11')).toBe('Oct 13 – Oct 19');
    expect(rangeLabel({ from: '2026-10-13', to: '2026-10-13' }, '2026-10-11')).toBe('Oct 13');
    expect(rangeLabel({ from: '2026-12-28', to: '2027-01-03' }, '2026-10-11')).toBe('Dec 28 – Jan 3, 2027');
  });
});

describe('times', () => {
  it.each([
    ['3pm', '15:00'],
    ['3:45p', '15:45'],
    ['3:45 PM', '15:45'],
    ['12am', '00:00'],
    ['12 pm', '12:00'],
    ['9 a.m.', '09:00'],
    ['15:30', '15:30'],
    ['1530', '15:30'],
    ['0930', '09:30'],
    ['9', '09:00'],
    ['3', '15:00'],
    ['03', '03:00'],
    ['noon', '12:00'],
    ['midnight', '00:00'],
    ['0', '00:00'],
  ])('reads %s as %s', (input, want) => expect(parseTime(input)).toBe(want));
  it.each(['', 'abc', '25:00', '13pm', '9:75', '0am'])('rejects %j', (input) => expect(parseTime(input)).toBeNull());
  it('formats, steps, and adds', () => {
    expect(formatTime('00:00')).toBe('12:00 AM');
    expect(formatTime('15:05')).toBe('3:05 PM');
    expect(TIME_STEPS).toHaveLength(96);
    expect(TIME_STEPS[37]).toBe('09:15');
    expect(nearestStep('09:29')).toBe('09:15');
    expect(addMinutes('09:30', 30)).toBe('10:00');
    expect(addMinutes('23:30', 60)).toBe('23:45');
  });
});
