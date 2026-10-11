// Pure helpers for the settings window, unit-tested in settings.test.ts.
import type { CatalogModel, SettingsView } from '@glossly/core/api';

// Component files export only components, so React Fast Refresh can hot-swap them.
export const hasWorkingKey = (view: SettingsView) => view.keys.some((k) => k.hasKey && k.lastTest?.ok);

/** A working key, or a local server that lists models. */
export const hasWorkingModel = (view: SettingsView) => hasWorkingKey(view) || Boolean(view.local.baseUrl && view.local.lastTest?.ok);

/** A model may run now: any working one under All models; under Local only, a local model on this computer (decision 34). */
export const canBackfill = (view: SettingsView) =>
  view.settings.privacy === 'local' ? Boolean(view.settings.local.model && view.local.baseUrl && view.local.loopback && view.local.lastTest?.ok) : hasWorkingModel(view);

export interface ProviderGroup {
  provider: string;
  label: string;
  models: CatalogModel[];
}

/** Models grouped by provider in `order` (unknown providers last), tested models first, then by name. */
export function groupByProvider(models: CatalogModel[], order: { provider: string; label: string }[]): ProviderGroup[] {
  const rank = (p: string) => {
    const i = order.findIndex((o) => o.provider === p);
    return i < 0 ? order.length : i;
  };
  const providers = [...new Set(models.map((m) => m.provider))].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  return providers.map((provider) => ({
    provider,
    label: order.find((o) => o.provider === provider)?.label ?? provider,
    models: models
      .filter((m) => m.provider === provider)
      .sort((a, b) => Number(a.capabilities === null) - Number(b.capabilities === null) || a.displayName.localeCompare(b.displayName)),
  }));
}

/** Short badges for a model's capabilities, or ["Untested"]. */
export function capabilityBadges(m: CatalogModel): string[] {
  const c = m.capabilities;
  if (!c) return ['Untested'];
  const out: string[] = [];
  if (c.structured !== 'none') out.push(c.structured === 'json_schema' ? 'Structured' : 'JSON mode');
  if (c.streaming) out.push('Streaming');
  out.push(`${c.speed[0]!.toUpperCase()}${c.speed.slice(1)}`, `${c.cost[0]!.toUpperCase()}${c.cost.slice(1)} cost`);
  if (c.reasoning) out.push('Reasoning');
  return out;
}

/** Why a model is a poor fit for a role, or null. */
export function roleWarning(role: 'fast' | 'chat' | 'decision', m: CatalogModel | undefined): string | null {
  if (!m) return null;
  if (!m.capabilities) return 'Untested: it may not work for this role.';
  if ((role === 'fast' || role === 'decision') && m.capabilities.structured === 'none') return 'This model has no structured output, which this role needs.';
  if (role === 'chat' && !m.capabilities.streaming) return 'This model does not stream, so answers appear all at once.';
  return null;
}

export interface KeyInput {
  key: string;
  code: string;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  meta: boolean;
}

const NAMED: Record<string, string> = {
  Space: 'Space',
  Enter: 'Return',
  Tab: 'Tab',
  Backspace: 'Backspace',
  Delete: 'Delete',
  Insert: 'Insert',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  Comma: ',',
  Period: '.',
  Slash: '/',
  Backquote: '`',
};

/**
 * An Electron accelerator from a keydown, or a reason it can't be one. Uses the physical key
 * (`code`), so Shift or the keyboard layout don't change the result. Needs Ctrl, Alt, or Win
 * unless the key is F1 to F24.
 */
export function toAccelerator(e: KeyInput): { accelerator: string } | { pending: true } | { error: string } {
  if (/^(Control|Alt|Shift|Meta|OS)(Left|Right)?$/.test(e.code) || ['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) return { pending: true };
  let key: string | null = null;
  if (/^Key[A-Z]$/.test(e.code)) key = e.code.slice(3);
  else if (/^Digit\d$/.test(e.code)) key = e.code.slice(5);
  else if (/^F([1-9]|1\d|2[0-4])$/.test(e.code)) key = e.code;
  else if (/^Numpad\d$/.test(e.code)) key = `num${e.code.slice(6)}`;
  else key = NAMED[e.code] ?? null;
  if (!key) return { error: 'That key cannot be part of a shortcut.' };
  const mods = [e.ctrl && 'Control', e.alt && 'Alt', e.shift && 'Shift', e.meta && 'Super'].filter(Boolean) as string[];
  if (!/^F\d+$/.test(key) && !e.ctrl && !e.alt && !e.meta) return { error: 'Use Ctrl, Alt, or Win with the key.' };
  return { accelerator: [...mods, key].join('+') };
}

/** "Control+Alt+Space" as "Ctrl + Alt + Space". */
export function formatAccelerator(acc: string): string {
  const names: Record<string, string> = { Control: 'Ctrl', CommandOrControl: 'Ctrl', CmdOrCtrl: 'Ctrl', Super: 'Win', Meta: 'Win', Return: 'Enter' };
  return acc
    .split('+')
    .map((p) => names[p] ?? p)
    .join(' + ');
}

/**
 * The key format appModes and blockList use: an app or site name as "Don't show here" stores it
 * ("Slack" covers slack.exe and Slack in a browser; title markers like "- Google Docs" or
 * "Discord |" are dropped), or a process name ending in ".exe" (lower-cased) for the app alone.
 */
export function normalizeAppKey(raw: string): string | null {
  const s = raw.trim();
  if (/\.exe$/i.test(s)) return s.toLowerCase();
  const name = s.replace(/^[-—–|]\s*/, '').replace(/\s*\|$/, '').trim();
  return name || null;
}

/** The message of an error thrown by ipcRenderer.invoke, without Electron's wrapper. */
export function errorText(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  return m.replace(/^Error invoking remote method '[^']+':\s*/, '').replace(/^(Error|TypeError):\s*/, '');
}

/** "just now", "5 minutes ago", "3 hours ago", "2 days ago". */
export function timeAgo(iso: string, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (!Number.isFinite(s)) return '';
  if (s < 60) return 'just now';
  const units: [number, string][] = [
    [86400, 'day'],
    [3600, 'hour'],
    [60, 'minute'],
  ];
  for (const [n, name] of units) {
    if (s >= n) {
      const v = Math.floor(s / n);
      return `${v} ${name}${v === 1 ? '' : 's'} ago`;
    }
  }
  return 'just now';
}

export const pct = (x: number) => `${Math.round(x * 100)}%`;

/** A typed email, lower-cased, or null when it isn't one. */
export function parseEmail(raw: string): string | null {
  const s = raw.trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) ? s : null;
}

/** A chat handle or display name without the leading "@", or null when empty. */
export function parseHandle(raw: string): string | null {
  const s = raw.trim().replace(/^@+/, '').trim();
  return s && s.length <= 100 ? s : null;
}
