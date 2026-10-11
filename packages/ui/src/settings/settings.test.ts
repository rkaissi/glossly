import { describe, expect, it } from 'vitest';
import type { CatalogModel, SettingsView } from '@glossly/core/api';
import {
  canBackfill,
  capabilityBadges,
  errorText,
  formatAccelerator,
  groupByProvider,
  normalizeAppKey,
  roleWarning,
  timeAgo,
  toAccelerator,
  type KeyInput,
} from './format';

const model = (provider: string, modelId: string, tested = true): CatalogModel => ({
  provider,
  modelId,
  ref: `${provider}:${modelId}`,
  displayName: modelId,
  capabilities: tested ? { structured: 'json_schema', streaming: true, tools: true, context: 131072, cost: 'low', speed: 'fast', tier: 2 } : null,
});

const order = [
  { provider: 'groq', label: 'Groq' },
  { provider: 'openai', label: 'OpenAI' },
];

describe('groupByProvider', () => {
  it('orders providers like the key list and puts untested models last', () => {
    const groups = groupByProvider([model('openai', 'gpt-5-mini'), model('groq', 'zeta', false), model('groq', 'alpha'), model('xai', 'grok')], order);
    expect(groups.map((g) => g.label)).toEqual(['Groq', 'OpenAI', 'xai']);
    expect(groups[0]!.models.map((m) => m.modelId)).toEqual(['alpha', 'zeta']);
  });
});

describe('capabilityBadges and roleWarning', () => {
  it('labels untested models', () => {
    expect(capabilityBadges(model('groq', 'x', false))).toEqual(['Untested']);
    expect(roleWarning('fast', model('groq', 'x', false))).toMatch(/Untested/);
  });
  it('lists capabilities', () => {
    expect(capabilityBadges(model('groq', 'x'))).toEqual(['Structured', 'Streaming', 'Fast', 'Low cost']);
  });
  it('warns when a fast model has no structured output', () => {
    const m = model('groq', 'x');
    m.capabilities!.structured = 'none';
    expect(roleWarning('fast', m)).toMatch(/structured/);
    expect(roleWarning('chat', m)).toBeNull();
  });
});

const k = (code: string, key: string, mods: Partial<KeyInput> = {}): KeyInput => ({ code, key, ctrl: false, alt: false, shift: false, meta: false, ...mods });

describe('toAccelerator', () => {
  it('builds Electron accelerators from physical keys', () => {
    expect(toAccelerator(k('Space', ' ', { ctrl: true, alt: true }))).toEqual({ accelerator: 'Control+Alt+Space' });
    expect(toAccelerator(k('KeyG', 'G', { ctrl: true, shift: true }))).toEqual({ accelerator: 'Control+Shift+G' });
    expect(toAccelerator(k('Digit1', '!', { alt: true, shift: true }))).toEqual({ accelerator: 'Alt+Shift+1' });
    expect(toAccelerator(k('KeyQ', 'q', { meta: true }))).toEqual({ accelerator: 'Super+Q' });
    expect(toAccelerator(k('F9', 'F9'))).toEqual({ accelerator: 'F9' });
  });
  it('waits while only modifiers are held', () => {
    expect(toAccelerator(k('ControlLeft', 'Control', { ctrl: true }))).toEqual({ pending: true });
  });
  it('needs Ctrl, Alt, or Win for normal keys', () => {
    expect(toAccelerator(k('KeyA', 'a'))).toHaveProperty('error');
    expect(toAccelerator(k('KeyA', 'A', { shift: true }))).toHaveProperty('error');
  });
  it('rejects keys that cannot be accelerators', () => {
    expect(toAccelerator(k('IntlBackslash', '<', { ctrl: true }))).toHaveProperty('error');
  });
});

describe('formatting', () => {
  it('formats accelerators for display', () => {
    expect(formatAccelerator('Control+Alt+Space')).toBe('Ctrl + Alt + Space');
    expect(formatAccelerator('Super+Return')).toBe('Win + Enter');
  });
  it('normalizes app keys', () => {
    expect(normalizeAppKey('  Slack ')).toBe('Slack');
    expect(normalizeAppKey('Code.exe')).toBe('code.exe');
    expect(normalizeAppKey('-Google Docs')).toBe('Google Docs');
    expect(normalizeAppKey('— Notion')).toBe('Notion');
    expect(normalizeAppKey('Discord |')).toBe('Discord');
    expect(normalizeAppKey('|')).toBeNull();
    expect(normalizeAppKey('   ')).toBeNull();
  });
  it('strips Electron invoke wrappers from errors', () => {
    expect(errorText(new Error("Error invoking remote method 'roles:set': Error: That model is not available with your keys."))).toBe(
      'That model is not available with your keys.',
    );
  });
  it('says how long ago', () => {
    const now = Date.parse('2026-10-10T12:00:00Z');
    expect(timeAgo('2026-10-10T11:59:30Z', now)).toBe('just now');
    expect(timeAgo('2026-10-10T11:55:00Z', now)).toBe('5 minutes ago');
    expect(timeAgo('2026-10-10T11:00:00Z', now)).toBe('1 hour ago');
    expect(timeAgo('2026-10-08T12:00:00Z', now)).toBe('2 days ago');
  });
});

describe('canBackfill', () => {
  const view = (privacy: 'all' | 'local', o: { key?: boolean; local?: { loopback: boolean; model: string | null } } = {}) =>
    ({
      settings: { privacy, local: { model: o.local?.model ?? null } },
      keys: [{ hasKey: Boolean(o.key), lastTest: o.key ? { ok: true, models: 3, at: '' } : null }],
      local: o.local ? { baseUrl: 'http://localhost:11434/v1', loopback: o.local.loopback, lastTest: { ok: true, models: 2, at: '' } } : { baseUrl: null, loopback: false, lastTest: null },
    }) as unknown as SettingsView;
  it('needs any working model under All models', () => {
    expect(canBackfill(view('all'))).toBe(false);
    expect(canBackfill(view('all', { key: true }))).toBe(true);
  });
  it('needs a local model on this computer under Local only, whatever keys exist', () => {
    expect(canBackfill(view('local', { key: true }))).toBe(false);
    expect(canBackfill(view('local', { local: { loopback: false, model: 'local:qwen3:4b' } }))).toBe(false);
    expect(canBackfill(view('local', { local: { loopback: true, model: 'local:qwen3:4b' } }))).toBe(true);
  });
});
