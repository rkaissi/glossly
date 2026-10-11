import type { Settings } from '../settings';
import { isBrowser, isTitleKey, keyMatches, siteKeyFor, type AppIdentity } from './apps';
import type { ClassifiedObstacle } from './obstacles';

/**
 * Apps and sites known to show their own toolbar when text is selected, so the pill waits the
 * full `capture.pillDelayMs` there before it picks a side. Same key format as appModes.
 */
export const DEFAULT_TOOLBAR_APPS: readonly string[] = [
  'winword.exe',
  'powerpnt.exe',
  'outlook.exe',
  'olk.exe',
  'onenote.exe',
  'notion.exe',
  'slack.exe',
  '- Google Docs',
  '- Google Slides',
  '- Word',
  '- Outlook',
  '- Slack',
  '| Medium',
];

/** Added to a learned time, so a toolbar that shows a little later than last time is still seen. */
export const LEARN_MARGIN_MS = 40;
const MAX_LEARNED = 200;

export type PillWaitReason = 'known' | 'learned' | 'short';

export interface PillWait {
  /** How long after mouse-up the last toolbar check may start. */
  ms: number;
  reason: PillWaitReason;
}

/** The toolbar wait for this app: full for known toolbar apps, learned, or short. */
export function pillWait(app: AppIdentity, s: Pick<Settings, 'capture' | 'toolbarWaits'>): PillWait {
  const full = s.capture.pillDelayMs;
  const short = Math.min(s.capture.shortWaitMs, full);
  if (DEFAULT_TOOLBAR_APPS.some((k) => keyMatches(k, app))) return { ms: full, reason: 'known' };
  const learned = s.toolbarWaits[siteKeyFor(app)];
  if (learned !== undefined) return { ms: Math.min(full, Math.max(short, learned + LEARN_MARGIN_MS)), reason: 'learned' };
  return { ms: short, reason: 'short' };
}

/**
 * The key a toolbar sighting is learned under, or null when there is no specific one: a browser
 * page without a site suffix in its title would otherwise slow every page in that browser.
 */
export function learnKeyFor(app: AppIdentity): string | null {
  const key = siteKeyFor(app);
  return isBrowser(app) && !isTitleKey(key) ? null : key;
}

/**
 * Whether one of the found obstacles is the app's own selection toolbar, which is what teaches
 * an app its wait: new since mouse-down, owned by the foreground process (not, say, another app's
 * notification), and a toolbar or popup window. A UIA menu never counts: it is a static menu bar
 * or a context menu, never a toolbar that a left-drag selection brings up.
 */
export function foundAppToolbar(found: readonly ClassifiedObstacle[], processName: string): boolean {
  return found.some((o) => o.status === 'new' && o.popup.process_name === processName && o.popup.kind !== 'menu' && o.popup.kind !== 'tooltip');
}

/**
 * Records that a toolbar was seen `seenMs` after mouse-up. Keeps the latest time seen, so the
 * wait only grows. Returns null when nothing changed.
 */
export function learnToolbarWait(waits: Readonly<Record<string, number>>, key: string, seenMs: number): Record<string, number> | null {
  const v = Math.max(0, Math.round(seenMs));
  const prev = waits[key];
  if (prev !== undefined && prev >= v) return null;
  const next = { ...waits };
  delete next[key];
  next[key] = v;
  const keys = Object.keys(next);
  for (const k of keys.slice(0, Math.max(0, keys.length - MAX_LEARNED))) delete next[k];
  return next;
}

export interface PollOptions {
  /** Mouse-up, on the same clock as `now`. */
  t0: number;
  /** The app's wait (see pillWait): the last check starts at or after t0 + waitMs. */
  waitMs: number;
  firstMs: number;
  intervalMs: number;
  /** One toolbar check. True if a new obstacle was found. */
  check: () => Promise<boolean>;
  /** True once the capture was superseded; polling stops. */
  stale: () => boolean;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

export interface PollResult {
  found: boolean;
  polls: number;
  /** ms after t0 at which the last check started. */
  at: number;
  /** Total time spent sleeping between checks. */
  slept: number;
}

/**
 * Checks for a selection toolbar from `firstMs` after mouse-up, every `intervalMs`, and stops as
 * soon as one is found or once a check that started after the wait finds none. Returns null if
 * the capture went stale.
 */
export async function pollForToolbar(o: PollOptions): Promise<PollResult | null> {
  const deadline = o.t0 + o.waitMs;
  let next = o.t0 + Math.min(o.firstMs, o.waitMs);
  let polls = 0;
  let slept = 0;
  for (;;) {
    const wait = next - o.now();
    if (wait > 0) {
      await o.sleep(wait);
      slept += wait;
    }
    if (o.stale()) return null;
    const started = o.now();
    polls++;
    const found = await o.check();
    if (o.stale()) return null;
    const at = Math.round(started - o.t0);
    if (found || started >= deadline) return { found, polls, at, slept: Math.round(slept) };
    next = Math.min(started + o.intervalMs, deadline);
  }
}
