import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../settings';
import { keyMatches, resolveAppMode, siteKeyFor, stripBrowserSuffix } from './apps';
import { countWords, gateAutoSelection, mayCopyFallback } from './gating';
import { placeBar, placePill } from './placement';

const s = DEFAULT_SETTINGS;
const slack = { process_name: 'slack.exe', title: '#design - Acme - Slack' };
const docs = { process_name: 'chrome.exe', title: 'Q4 plan - Google Docs - Google Chrome' };
const edgeDocs = { process_name: 'msedge.exe', title: 'Q4 plan - Google Docs - Personal - Microsoft\u200b Edge' };

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

  it('applies the 3-word minimum, password, and per-app mode', () => {
    expect(gateAutoSelection({ text: 'one two three', is_password: false }, slack, s).ok).toBe(true);
    expect(gateAutoSelection({ text: 'one two', is_password: false }, slack, s)).toMatchObject({ ok: false, reason: 'too_short' });
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

  it('collapses to a 12 px dot when both sides are taken', () => {
    const obstacles = [
      { x: 500, y: 340, w: 420, h: 48 },
      { x: 500, y: 428, w: 420, h: 36 },
    ];
    const p = placePill({ selection, anchor: { x: 840, y: 410 }, obstacles, size, workArea });
    expect(p).toMatchObject({ mode: 'dot', side: 'end' });
    expect(p.rect.w).toBe(12);
    expect(p.rect.x).toBe(844);
  });

  it('goes above at the bottom of the screen and stays inside the work area', () => {
    const p = placePill({ selection: { x: 1900, y: 1010, w: 20, h: 20 }, obstacles: [], size, workArea });
    expect(p.side).toBe('above');
    expect(p.rect.x + p.rect.w).toBeLessThanOrEqual(1920);
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
