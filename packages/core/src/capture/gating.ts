import type { Settings } from '../settings';
import { resolveAppMode, type AppIdentity, type ResolvedMode } from './apps';

const segmenter = new Intl.Segmenter(undefined, { granularity: 'word' });

/** Counts words with Intl.Segmenter, so CJK text without spaces is counted correctly. */
export function countWords(text: string, stopAt = Infinity): number {
  let n = 0;
  for (const s of segmenter.segment(text)) {
    if (s.isWordLike && ++n >= stopAt) break;
  }
  return n;
}

export type SkipReason = 'empty' | 'too_short' | 'password' | 'blocked' | 'mode_off' | 'mode_hotkey';

export type GateResult = { ok: true; mode: ResolvedMode } | { ok: false; reason: SkipReason; mode: ResolvedMode };

type GateSettings = Pick<Settings, 'appModes' | 'blockList' | 'capture'>;

/** May the app ask the helper for the selection at all? Checked before any read. */
export function gateApp(app: AppIdentity, trigger: 'auto' | 'hotkey', settings: GateSettings): GateResult {
  const mode = resolveAppMode(app, settings);
  if (mode.blocked) return { ok: false, reason: 'blocked', mode };
  if (mode.mode === 'off') return { ok: false, reason: 'mode_off', mode };
  if (trigger === 'auto' && mode.mode === 'hotkey') return { ok: false, reason: 'mode_hotkey', mode };
  return { ok: true, mode };
}

/** Auto pill: after a read, should the pill show for this selection? */
export function gateAutoSelection(
  sel: { text: string; is_password: boolean },
  app: AppIdentity,
  settings: GateSettings,
): GateResult {
  const g = gateApp(app, 'auto', settings);
  if (!g.ok) return g;
  if (sel.is_password) return { ok: false, reason: 'password', mode: g.mode };
  if (!sel.text.trim()) return { ok: false, reason: 'empty', mode: g.mode };
  if (countWords(sel.text, settings.capture.minWords) < settings.capture.minWords)
    return { ok: false, reason: 'too_short', mode: g.mode };
  return g;
}

/**
 * Hotkey path: may we fall back to simulated copy? Only when the UIA read came back empty,
 * the app is not blocked or off, and the field is not a password field.
 */
export function mayCopyFallback(sel: { text: string; is_password: boolean } | null, app: AppIdentity, settings: GateSettings): boolean {
  if (sel?.is_password) return false;
  if (sel && sel.text.trim()) return false;
  return gateApp(app, 'hotkey', settings).ok;
}
