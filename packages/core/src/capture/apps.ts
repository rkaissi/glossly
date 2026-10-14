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
  // The live-check page viewer, when the dev build counts it as a browser (enableTestViewer).
  /\s+-\s+Glossly Test Viewer$/,
  // Edge and Chrome add "and N more pages" / profile names in some locales.
  /\s+-\s+Personal$/,
  /\s+-\s+Work$/,
  // An unread count some sites put last ("#planning - Discord (3)"), so a rule doesn't hold the count (Step 21).
  /\s+\(\d+\+?\)$/,
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

/** A key naming a process ("slack.exe"): matched against the process name only. */
export const isProcessKey = (k: string) => /\.exe$/i.test(k.trim());

/** A title key as a plain name: "- Google Docs" as "Google Docs", "Discord |" as "Discord". */
export const titleKeyName = (k: string) => k.trim().replace(/^[-—–|]\s*/, '').replace(/\s*\|$/, '');

/** "discord.exe" as "Discord", "ms-teams.exe" as "Ms-teams". */
export function appLabel(processName: string): string {
  const base = processName.replace(/\.exe$/i, '');
  return base ? base[0]!.toUpperCase() + base.slice(1) : processName;
}

/**
 * True if a key matches the app. Three kinds:
 * - a process name ("slack.exe"), matched case-insensitively;
 * - a plain app or site name ("Discord", "Google Docs"), as "Don't show here" stores it: the
 *   process name without ".exe", or in a browser, the site named in the title (or the whole title);
 * - an older title key ("- Google Docs", "| Medium", "Discord |"), matched against the title after
 *   stripping the browser's own suffix (and, for a prefix key, an unread count).
 */
export function keyMatches(key: string, app: AppIdentity): boolean {
  const k = key.trim();
  if (!k) return false;
  if (isProcessKey(k)) return app.process_name.toLowerCase() === k.toLowerCase();
  if (isTitleKey(k)) {
    const title = stripBrowserSuffix(app.title).toLowerCase();
    if (/^[-—–|]/.test(k)) return title.endsWith(k.toLowerCase());
    const site = k.slice(0, -1).trim().toLowerCase();
    const rest = title.replace(UNREAD_PREFIX, '');
    return rest === site || rest.startsWith(`${site} |`);
  }
  const name = k.toLowerCase();
  if (app.process_name.toLowerCase().replace(/\.exe$/, '') === name) return true;
  if (!isBrowser(app)) return false;
  const site = siteKeyFor(app);
  if (isTitleKey(site) && titleKeyName(site).toLowerCase() === name) return true;
  return stripBrowserSuffix(app.title).replace(UNREAD_PREFIX, '').trim().toLowerCase() === name;
}

/** Sites that put their own name first in a bar-split title ("Discord | Casey, Robin"). */
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

/** The live-check page viewer's title suffix; its windows run as electron.exe. */
export const TEST_VIEWER_SUFFIX = ' - Glossly Test Viewer';
let testViewer = false;

/**
 * Dev builds only (`GLOSSLY_TEST_VIEWER=1`): the page viewer that live checks use instead of the
 * owner's browsers counts as a browser, so test pages get site detection (AGENTS.md, Oct 14).
 * Only electron.exe windows with the viewer's title suffix count, never Glossly's own.
 */
export function enableTestViewer(on = true): void {
  testViewer = on;
}

export const isBrowser = (app: Pick<AppIdentity, 'process_name'> & { title?: string }) => {
  const p = app.process_name.toLowerCase();
  return BROWSERS.includes(p) || (testViewer && p === 'electron.exe' && Boolean(app.title?.endsWith(TEST_VIEWER_SUFFIX)));
};

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

/**
 * The name "Don't show here" stores and shows for this app: the site's name for a browser page
 * ("Discord", "Google Docs"), else the app's ("Slack", or "Chrome" for a page with no site name).
 */
export function placeNameFor(app: AppIdentity): string {
  const key = siteKeyFor(app);
  return isTitleKey(key) ? titleKeyName(key) : appLabel(app.process_name);
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
  // Site and title keys are more specific than process names (a site inside a browser).
  const userKeys = Object.keys(settings.appModes).sort((a, b) => Number(isProcessKey(a)) - Number(isProcessKey(b)));
  for (const key of userKeys) {
    if (keyMatches(key, app)) return { mode: settings.appModes[key]!, blocked: false, matched: key };
  }
  for (const key of DEFAULT_HOTKEY_ONLY) {
    if (keyMatches(key, app)) return { mode: 'hotkey', blocked: false, matched: key };
  }
  return { mode: 'auto', blocked: false, matched: null };
}
