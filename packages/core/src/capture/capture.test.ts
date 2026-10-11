import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../settings';
import { keyMatches, placeNameFor, resolveAppMode, siteKeyFor, stripBrowserSuffix } from './apps';
import { countWords, gateAutoSelection, mayCopyFallback } from './gating';
import { classifyObstacles, type Popup } from './obstacles';
import { foundAppToolbar, learnKeyFor, learnToolbarWait, pillWait, pollForToolbar, type PollOptions } from './pill-wait';
import { placeBar, placePill } from './placement';

const s = DEFAULT_SETTINGS;
const slack = { process_name: 'slack.exe', title: '#design - Acme - Slack' };
const docs = { process_name: 'chrome.exe', title: 'Q4 plan - Google Docs - Google Chrome' };
const edgeDocs = { process_name: 'msedge.exe', title: 'Q4 plan - Google Docs - Personal - Microsoft\u200b Edge' };
const medium = { process_name: 'chrome.exe', title: 'On waiting | by Ann Lee | Medium - Google Chrome' };

describe('app matching', () => {
  it('strips browser suffixes', () => {
    expect(stripBrowserSuffix(docs.title)).toBe('Q4 plan - Google Docs');
    expect(stripBrowserSuffix(edgeDocs.title)).toBe('Q4 plan - Google Docs');
  });

  it('matches process names and title suffixes', () => {
    expect(keyMatches('Slack.EXE', slack)).toBe(true);
    expect(keyMatches('- Google Docs', docs)).toBe(true);
    expect(keyMatches('- Google Docs', edgeDocs)).toBe(true);
    expect(keyMatches('- Google Docs', slack)).toBe(false);
  });

  it('builds a site key for browsers and a process key otherwise', () => {
    expect(siteKeyFor(docs)).toBe('- Google Docs');
    expect(siteKeyFor(slack)).toBe('slack.exe');
    expect(siteKeyFor(medium)).toBe('| Medium');
    expect(keyMatches('| Medium', medium)).toBe(true);
  });

  it('keeps the site name when it comes first, past an unread count', () => {
    const dm = { process_name: 'chrome.exe', title: '(214) Discord | Casey Lin, Robin Diaz - Google Chrome' };
    const server = { process_name: 'chrome.exe', title: 'Discord | #general | Acme Server - Google Chrome' };
    expect(siteKeyFor(dm)).toBe('Discord |');
    expect(siteKeyFor(server)).toBe('Discord |');
    expect(keyMatches('Discord |', dm)).toBe(true);
    expect(keyMatches('Discord |', server)).toBe(true);
    expect(keyMatches('Discord |', { process_name: 'chrome.exe', title: 'Discord tips | Medium - Google Chrome' })).toBe(false);
    // A name-like last part still wins for sites that put it last.
    expect(siteKeyFor({ process_name: 'chrome.exe', title: 'How to ship faster | The Verge - Google Chrome' })).toBe('| The Verge');
    // Only the first part reads like a name.
    expect(siteKeyFor({ process_name: 'chrome.exe', title: 'Acme | Q3 planning, notes and actions - Google Chrome' })).toBe('Acme |');
    expect(resolveAppMode(dm, { ...s, appModes: { 'Discord |': 'off' } }).mode).toBe('off');
  });

  it("names the place plainly for Don't show here, and the name matches the app and the site", () => {
    const dm = { process_name: 'chrome.exe', title: '(12) Discord | Casey Lin, Robin Diaz - Google Chrome' };
    const discordApp = { process_name: 'Discord.exe', title: 'Discord' };
    expect(placeNameFor(dm)).toBe('Discord');
    expect(placeNameFor(docs)).toBe('Google Docs');
    expect(placeNameFor(medium)).toBe('Medium');
    expect(placeNameFor(slack)).toBe('Slack');
    expect(placeNameFor({ process_name: 'chrome.exe', title: 'New Tab - Google Chrome' })).toBe('Chrome');
    expect(keyMatches('Discord', dm)).toBe(true);
    expect(keyMatches('discord', discordApp)).toBe(true);
    expect(keyMatches('Discord', { process_name: 'chrome.exe', title: 'Discord - Google Chrome' })).toBe(true);
    expect(keyMatches('Discord', { process_name: 'chrome.exe', title: 'Discord tips | Medium - Google Chrome' })).toBe(false);
    expect(keyMatches('Google Docs', edgeDocs)).toBe(true);
    expect(keyMatches('Google Docs', slack)).toBe(false);
    expect(keyMatches('Slack', slack)).toBe(true);
    // A site name beats the browser's process rule, and a name never matches another app's window title.
    expect(resolveAppMode(dm, { ...s, appModes: { 'chrome.exe': 'off', Discord: 'hotkey' } }).mode).toBe('hotkey');
    expect(keyMatches('Discord', { process_name: 'notepad.exe', title: 'Discord' })).toBe(false);
  });

  it('blocks password managers and lets user modes win over defaults', () => {
    expect(resolveAppMode({ process_name: '1Password.exe', title: '1Password' }, s)).toMatchObject({ blocked: true, mode: 'off' });
    expect(resolveAppMode({ process_name: 'chrome.exe', title: 'Vault - Bitwarden - Google Chrome' }, s).blocked).toBe(true);
    expect(resolveAppMode({ process_name: 'excel.exe', title: 'Book1' }, s).mode).toBe('hotkey');
    expect(resolveAppMode({ process_name: 'excel.exe', title: 'Book1' }, { ...s, appModes: { 'excel.exe': 'auto' } }).mode).toBe('auto');
    // A site rule beats the browser's process rule.
    const modes = { 'chrome.exe': 'off', '- Google Docs': 'auto' } as const;
    expect(resolveAppMode(docs, { ...s, appModes: modes }).mode).toBe('auto');
  });

  it('user block list entries block', () => {
    expect(resolveAppMode(slack, { ...s, blockList: ['slack.exe'] }).blocked).toBe(true);
  });
});

describe('gating', () => {
  it('counts words, including CJK', () => {
    expect(countWords('one two  three')).toBe(3);
    expect(countWords("it's fine, ok?")).toBe(3);
    expect(countWords('   ')).toBe(0);
    expect(countWords('我们明天开会讨论')).toBeGreaterThanOrEqual(3);
  });

  it('shows the pill for any non-empty selection, and still skips passwords and empty text', () => {
    expect(gateAutoSelection({ text: 'one', is_password: false }, slack, s).ok).toBe(true);
    expect(gateAutoSelection({ text: 'one two', is_password: false }, slack, s).ok).toBe(true);
    expect(gateAutoSelection({ text: 'one two', is_password: false }, slack, { ...s, capture: { ...s.capture, minWords: 3 } })).toMatchObject({
      ok: false,
      reason: 'too_short',
    });
    expect(gateAutoSelection({ text: '', is_password: true }, slack, s)).toMatchObject({ ok: false, reason: 'password' });
    expect(gateAutoSelection({ text: '  ', is_password: false }, slack, s)).toMatchObject({ ok: false, reason: 'empty' });
    const hk = { ...s, appModes: { 'slack.exe': 'hotkey' as const } };
    expect(gateAutoSelection({ text: 'one two three', is_password: false }, slack, hk)).toMatchObject({ reason: 'mode_hotkey' });
  });

  it('copy fallback only when empty, not password, not blocked', () => {
    expect(mayCopyFallback({ text: '', is_password: false }, slack, s)).toBe(true);
    expect(mayCopyFallback(null, slack, s)).toBe(true);
    expect(mayCopyFallback({ text: 'already have it', is_password: false }, slack, s)).toBe(false);
    expect(mayCopyFallback({ text: '', is_password: true }, slack, s)).toBe(false);
    expect(mayCopyFallback({ text: '', is_password: false }, { process_name: 'keepassxc.exe', title: 'x' }, s)).toBe(false);
    expect(mayCopyFallback(null, slack, { ...s, appModes: { 'slack.exe': 'off' } })).toBe(false);
    // Hotkey-only apps still get the hotkey path.
    expect(mayCopyFallback(null, { process_name: 'excel.exe', title: 'Book1' }, s)).toBe(true);
  });
});

describe('placement', () => {
  const workArea = { x: 0, y: 0, w: 1920, h: 1040 };
  const selection = { x: 600, y: 400, w: 240, h: 20 };
  const size = { w: 120, h: 32 };

  it('goes below by default', () => {
    const p = placePill({ selection, obstacles: [], size, workArea });
    expect(p).toMatchObject({ mode: 'pill', side: 'below' });
    expect(p.rect.y).toBe(428);
  });

  it('moves above when a toolbar is below', () => {
    const p = placePill({ selection, obstacles: [{ x: 600, y: 428, w: 380, h: 36 }], size, workArea });
    expect(p.side).toBe('above');
    expect(p.rect.y + p.rect.h).toBeLessThanOrEqual(selection.y);
  });

  it('collapses to a dot drawn inside a larger window when both sides are taken', () => {
    const obstacles = [
      { x: 500, y: 340, w: 420, h: 48 },
      { x: 500, y: 428, w: 420, h: 36 },
    ];
    const p = placePill({ selection, anchor: { x: 840, y: 410 }, obstacles, size, workArea });
    expect(p).toMatchObject({ mode: 'dot', side: 'end' });
    // The window is at least Windows' minimum (29x38 DIP); the dot is a fixed 18 px circle.
    expect(p.rect).toMatchObject({ w: 40, h: 40 });
    expect(p.mark).toEqual({ x: 844, y: 401, w: 18, h: 18 });
    // The dot sits inside the window, centered on the selection's last line.
    expect(p.mark!.x - p.rect.x).toBe(6);
    expect(p.mark!.y + 9).toBe(410);
  });

  it('puts the dot just past the end of the last line, not at the mouse-up point (decision 44)', () => {
    const obstacles = [
      { x: 500, y: 300, w: 420, h: 48 },
      { x: 500, y: 450, w: 420, h: 36 },
    ];
    // Two lines; the second is shorter, and the mouse was released out past its end.
    const twoLines = { x: 600, y: 380, w: 300, h: 40 };
    const p = placePill({ selection: twoLines, anchor: { x: 890, y: 412 }, lastLine: { x: 600, y: 400, w: 120, h: 20 }, obstacles, size, workArea });
    expect(p.mode).toBe('dot');
    expect(p.mark!.x).toBe(600 + 120 + 3);
    expect(p.mark!.y + 9).toBe(410);
  });

  it('keeps the dot window on screen at the right edge', () => {
    const obstacles = [
      { x: 1700, y: 340, w: 220, h: 48 },
      { x: 1700, y: 428, w: 220, h: 36 },
    ];
    const p = placePill({ selection: { x: 1800, y: 400, w: 118, h: 20 }, obstacles, size, workArea });
    expect(p.mode).toBe('dot');
    expect(p.rect.x + p.rect.w).toBeLessThanOrEqual(1920);
    expect(p.mark!.x).toBe(p.rect.x + 6);
  });

  it('goes above at the bottom of the screen and stays inside the work area', () => {
    const p = placePill({ selection: { x: 1900, y: 1010, w: 20, h: 20 }, obstacles: [], size, workArea });
    expect(p.side).toBe('above');
    expect(p.rect.x + p.rect.w).toBeLessThanOrEqual(1920);
  });

  it('picks a left edge with room for the widest bar near the right edge', () => {
    // Centered on the anchor the pill would start at 1770; the bar can grow to 680 px.
    const sel = { x: 1700, y: 400, w: 160, h: 20 };
    const p = placePill({ selection: sel, obstacles: [], size: { w: 200, h: 40 }, growW: 680, workArea });
    expect(p.rect.x).toBe(1920 - 680);
    expect(p.rect.w).toBe(200);
    // Away from the edge it stays centered on the anchor.
    expect(placePill({ selection, obstacles: [], size: { w: 200, h: 40 }, growW: 680, workArea }).rect.x).toBe(740);
    const bar = placeBar({ selection: sel, obstacles: [], size: { w: 200, h: 40 }, growW: 680, workArea });
    expect(bar.rect.x + 680).toBeLessThanOrEqual(1920);
  });

  it('the bar never becomes a dot', () => {
    const obstacles = [
      { x: 0, y: 340, w: 1920, h: 48 },
      { x: 0, y: 428, w: 1920, h: 36 },
    ];
    const p = placeBar({ selection, obstacles, size: { w: 420, h: 48 }, workArea });
    expect(p.mode).toBe('pill');
  });
});

describe('obstacles', () => {
  const selection = { x: 600, y: 400, w: 240, h: 20 };
  const popup = (over: Partial<Popup> = {}): Popup => ({
    source: 'uia',
    kind: 'toolbar',
    bounds: { x: 600, y: 340, w: 300, h: 40 },
    id: 'u:42.1',
    class_name: 'menu',
    process_name: 'chrome.exe',
    ...over,
  });

  it('counts everything but tooltips and covering windows without a baseline', () => {
    const found = [
      popup(),
      popup({ kind: 'tooltip', bounds: { x: 600, y: 430, w: 80, h: 20 }, id: 'u:7' }),
      popup({ source: 'window', kind: 'popup_window', bounds: { x: 0, y: 0, w: 1400, h: 700 }, id: 'w:9' }),
    ];
    expect(classifyObstacles(found, null, selection).map((o) => [o.status, o.side])).toEqual([
      ['new', 'above'],
      ['tooltip', 'below'],
      ['covers_selection', 'overlap'],
    ]);
  });

  it('skips what was already there at mouse-down', () => {
    const chrome = popup({ source: 'window', kind: 'tool_window', bounds: { x: 500, y: 430, w: 600, h: 30 }, id: 'w:5' });
    const baseline = [popup(), chrome];
    const fresh = popup({ id: 'u:42.2', bounds: { x: 620, y: 430, w: 200, h: 36 } });
    const out = classifyObstacles([popup(), chrome, fresh], baseline, selection);
    expect(out.map((o) => o.status)).toEqual(['preexisting', 'preexisting', 'new']);
  });

  it('counts a known window again if it moved or was replaced', () => {
    const before = popup({ source: 'window', kind: 'tool_window', id: 'w:5' });
    const moved = { ...before, bounds: { ...before.bounds, y: 430 } };
    const replaced = { ...before, id: 'w:6' };
    expect(classifyObstacles([moved, replaced], [before], selection).map((o) => o.status)).toEqual(['new', 'new']);
  });

  it('matches by class name when the provider gives no id', () => {
    const before = popup({ id: '' });
    expect(classifyObstacles([popup({ id: '' })], [before], selection)[0]!.status).toBe('preexisting');
    expect(classifyObstacles([popup({ id: '', class_name: 'other' })], [before], selection)[0]!.status).toBe('new');
  });
});

describe('pill wait', () => {
  const notepad = { process_name: 'notepad.exe', title: 'notes.txt - Notepad' };

  it('waits in full only where a toolbar is known or was learned', () => {
    expect(pillWait(slack, s)).toEqual({ ms: 250, reason: 'known' });
    expect(pillWait(docs, s)).toEqual({ ms: 250, reason: 'known' });
    expect(pillWait(medium, s)).toEqual({ ms: 250, reason: 'known' });
    expect(pillWait(notepad, s)).toEqual({ ms: 100, reason: 'short' });
    // Learned time plus the margin, between the short and the full wait.
    expect(pillWait(notepad, { ...s, toolbarWaits: { 'notepad.exe': 120 } })).toEqual({ ms: 160, reason: 'learned' });
    expect(pillWait(notepad, { ...s, toolbarWaits: { 'notepad.exe': 400 } })).toEqual({ ms: 250, reason: 'learned' });
    expect(pillWait(notepad, { ...s, toolbarWaits: { 'notepad.exe': 0 } })).toEqual({ ms: 100, reason: 'learned' });
  });

  it('learns per app or site, never for a whole browser, and only grows', () => {
    expect(learnKeyFor(notepad)).toBe('notepad.exe');
    expect(learnKeyFor({ process_name: 'chrome.exe', title: 'Board - Trello - Google Chrome' })).toBe('- Trello');
    expect(learnKeyFor({ process_name: 'chrome.exe', title: 'Untitled - Google Chrome' })).toBeNull();
    const a = learnToolbarWait({}, 'notepad.exe', 131.6);
    expect(a).toEqual({ 'notepad.exe': 132 });
    expect(learnToolbarWait(a!, 'notepad.exe', 90)).toBeNull();
    expect(learnToolbarWait(a!, 'notepad.exe', 250)).toEqual({ 'notepad.exe': 250 });
  });

  it("learns only from the app's own new toolbars, never from a menu bar", () => {
    const sel = { x: 600, y: 400, w: 240, h: 20 };
    const p = (over: Partial<Popup>): Popup => ({
      source: 'uia',
      kind: 'toolbar',
      bounds: { x: 600, y: 340, w: 300, h: 40 },
      id: 'u:1',
      class_name: '',
      process_name: 'notepad.exe',
      ...over,
    });
    const found = (...ps: Popup[]) => classifyObstacles(ps, [], sel);
    expect(foundAppToolbar(found(p({})), 'notepad.exe')).toBe(true);
    expect(foundAppToolbar(found(p({ source: 'window', kind: 'popup_window', id: 'w:3' })), 'notepad.exe')).toBe(true);
    // Notepad's menu bar, missed by the baseline: it may still steer placement, but it teaches nothing.
    expect(foundAppToolbar(found(p({ kind: 'menu', bounds: { x: 80, y: 340, w: 160, h: 33 } })), 'notepad.exe')).toBe(false);
    expect(foundAppToolbar(found(p({ process_name: 'teams.exe' })), 'notepad.exe')).toBe(false);
    expect(foundAppToolbar(classifyObstacles([p({})], [p({})], sel), 'notepad.exe')).toBe(false);
  });

  // A fake clock: sleep and each check advance it.
  function clock(checkMs: number, foundAt: number | null) {
    let t = 1000;
    const starts: number[] = [];
    const o: PollOptions = {
      t0: 1000,
      waitMs: 250,
      firstMs: 100,
      intervalMs: 35,
      now: () => t,
      sleep: async (ms) => {
        t += ms;
      },
      check: async () => {
        starts.push(t - 1000);
        t += checkMs;
        return foundAt !== null && t - 1000 - checkMs >= foundAt;
      },
      stale: () => false,
    };
    return { o, starts, setT: (v: number) => (t = v) };
  }

  it('polls from 100 ms until a check starts after the wait', async () => {
    const { o, starts } = clock(10, null);
    const r = await pollForToolbar(o);
    expect(starts).toEqual([100, 135, 170, 205, 240, 250]);
    expect(r).toMatchObject({ found: false, polls: 6, at: 250 });
  });

  it('stops at the first check that finds a toolbar', async () => {
    const { o, starts } = clock(10, 130);
    const r = await pollForToolbar(o);
    expect(starts).toEqual([100, 135]);
    expect(r).toMatchObject({ found: true, polls: 2, at: 135 });
  });

  it('a short wait is one check, right away if the selection read was slow', async () => {
    const fast = clock(20, null);
    expect(await pollForToolbar({ ...fast.o, waitMs: 100 })).toMatchObject({ found: false, polls: 1, at: 100 });
    const slow = clock(20, null);
    slow.setT(1130);
    expect(await pollForToolbar({ ...slow.o, waitMs: 100 })).toMatchObject({ polls: 1, at: 130, slept: 0 });
  });

  it('gives up when the capture goes stale', async () => {
    const { o } = clock(10, null);
    let n = 0;
    expect(await pollForToolbar({ ...o, stale: () => ++n > 2 })).toBeNull();
  });
});
