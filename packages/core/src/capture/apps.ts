import type { AppMode, Settings } from '../settings';

/** Password managers. Glossly never reads from these, on any trigger. */
export const DEFAULT_BLOCK_LIST: readonly string[] = [
  '1password.exe',
  'bitwarden.exe',
  'keepass.exe',
  'keepassxc.exe',
  'dashlane.exe',
  'lastpass.exe',
  'enpass.exe',
  'nordpass.exe',
  'keeper.exe',
  'keeperpasswordmanager.exe',
  'roboform.exe',
  'proton pass.exe',
  'protonpass.exe',
  'credentialuibroker.exe',
  // Web vaults, matched by window-title suffix.
  '- Bitwarden',
  '- Bitwarden Web vault',
  '- 1Password',
  '- LastPass',
  '- Proton Pass',
];

/**
 * Apps and sites where the auto pill conflicts with the app's own behavior. Drag-selecting
 * in spreadsheets selects cells, and terminals copy on select. Extend this after the
 * Phase 0 hand tests (evals/capture.md).
 */
export const DEFAULT_HOTKEY_ONLY: readonly string[] = [
  'excel.exe',
  '- Google Sheets',
  'windowsterminal.exe',
  'conhost.exe',
  'mstsc.exe',
];

/** Browser suffixes stripped from titles so "Doc - Google Docs - Google Chrome" matches "- Google Docs". */
const BROWSER_SUFFIXES = [
  /\s+-\s+Google Chrome$/,
  /\s+-\s+Microsoft\u200b? Edge$/,
  /\s+—\s+Mozilla Firefox$/,
  /\s+-\s+Mozilla Firefox$/,
  /\s+-\s+Brave$/,
  /\s+-\s+Opera$/,
  /\s+-\s+Vivaldi$/,
  /\s+-\s+Arc$/,
  /\s+-\s+Chromium$/,
  // Edge and Chrome add "and N more pages" / profile names in some locales.
  /\s+-\s+Personal$/,
  /\s+-\s+Work$/,
];

export function stripBrowserSuffix(title: string): string {
  let t = title.trim();
  for (let i = 0; i < 3; i++) {
    const before = t;
    for (const re of BROWSER_SUFFIXES) t = t.replace(re, '');
    if (t === before) break;
  }
  return t;
}

export interface AppIdentity {
  process_name: string;
  title: string;
}

/**
 * Title keys: a suffix starting with a dash ("- Google Docs") or a bar ("| Medium"), or a
 * prefix ending with a bar, for sites that put their name first ("Discord |").
 */
export const isTitleKey = (k: string) => /^[-—–|]/.test(k) || /\s\|$/.test(k);

/** An unread count or dot a site puts in front of its title: "(214) Discord | ...", "• Slack". */
const UNREAD_PREFIX = /^(?:\(\d+\+?\)|\[\d+\+?\]|[•●*])\s*/;

/**
 * True if a key matches the app: process names match case-insensitively; title keys match the
 * title after stripping the browser's own suffix (and, for a prefix key, an unread count).
 */
export function keyMatches(key: string, app: AppIdentity): boolean {
  const k = key.trim();
  if (!k) return false;
  if (isTitleKey(k)) {
    const title = stripBrowserSuffix(app.title).toLowerCase();
    if (/^[-—–|]/.test(k)) return title.endsWith(k.toLowerCase());
    const site = k.slice(0, -1).trim().toLowerCase();
    const rest = title.replace(UNREAD_PREFIX, '');
    return rest === site || rest.startsWith(`${site} |`);
  }
  return app.process_name.toLowerCase() === k.toLowerCase();
}

/** Sites that put their own name first in a bar-split title ("Discord | Tom, Nabil"). */
const NAME_FIRST_SITES = /^(?:discord|whatsapp|messenger|instagram|telegram|signal|linkedin|facebook|reddit|x|twitter|threads|bluesky|teams)$/i;

/** A part of a title that reads like a site's name: short, no commas, @, or #. */
const brandLike = (p: string) => p.length <= 24 && !/[,#@/:]/.test(p) && p.split(/\s+/).length <= 3;

/** The site's name in a bar-split title: first for sites that lead with it, else the last part, unless only the first looks like a name. */
function barSiteKey(parts: string[]): string {
  const first = parts[0]!;
  const last = parts[parts.length - 1]!;
  if (NAME_FIRST_SITES.test(first)) return `${first} |`;
  if (NAME_FIRST_SITES.test(last) || brandLike(last)) return `| ${last}`;
  if (brandLike(first)) return `${first} |`;
  return `| ${last}`;
}

const BROWSERS = ['chrome.exe', 'msedge.exe', 'firefox.exe', 'brave.exe', 'opera.exe', 'vivaldi.exe', 'arc.exe'];

export const isBrowser = (app: Pick<AppIdentity, 'process_name'>) => BROWSERS.includes(app.process_name.toLowerCase());

/** The key "Don't show here" would store for this app: the site's part of the title for browsers, else the process name. */
export function siteKeyFor(app: AppIdentity): string {
  if (isBrowser(app)) {
    const title = stripBrowserSuffix(app.title);
    const parts = title.split(/\s+[-—–]\s+/);
    if (parts.length > 1) return `- ${parts[parts.length - 1]}`;
    const barParts = title.replace(UNREAD_PREFIX, '').split(/\s+\|\s+/);
    if (barParts.length > 1) return barSiteKey(barParts);
  }
  return app.process_name.toLowerCase();
}

export interface ResolvedMode {
  mode: AppMode;
  blocked: boolean;
  /** The key that decided the mode, for the settings UI and debug view. */
  matched: string | null;
}

export function resolveAppMode(app: AppIdentity, settings: Pick<Settings, 'appModes' | 'blockList'>): ResolvedMode {
  for (const key of [...DEFAULT_BLOCK_LIST, ...settings.blockList]) {
    if (keyMatches(key, app)) return { mode: 'off', blocked: true, matched: key };
  }
  // Title-suffix keys are more specific than process names (a site inside a browser).
  const userKeys = Object.keys(settings.appModes).sort((a, b) => Number(isTitleKey(b)) - Number(isTitleKey(a)));
  for (const key of userKeys) {
    if (keyMatches(key, app)) return { mode: settings.appModes[key]!, blocked: false, matched: key };
  }
  for (const key of DEFAULT_HOTKEY_ONLY) {
    if (keyMatches(key, app)) return { mode: 'hotkey', blocked: false, matched: key };
  }
  return { mode: 'auto', blocked: false, matched: null };
}
