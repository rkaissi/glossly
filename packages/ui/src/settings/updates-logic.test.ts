import { describe, expect, it } from 'vitest';
import { updateLine } from './updates-logic';

const now = Date.parse('2026-10-13T12:00:00Z');
const at = (state: Parameters<typeof updateLine>[0]['state']) => updateLine({ current: '0.1.0', state }, now);

describe('updateLine', () => {
  it('offers no button in a dev build or while downloading', () => {
    expect(at({ status: 'unsupported' }).button).toBeNull();
    expect(at({ status: 'downloading', version: '0.2.0', percent: 42 })).toEqual({ text: 'Downloading version 0.2.0… 42%', button: null });
  });

  it('checks, then says when it last did', () => {
    expect(at({ status: 'checking' }).button).toMatchObject({ action: 'check', disabled: true });
    expect(at({ status: 'none', checkedAt: '2026-10-13T11:59:30Z' }).text).toBe("You're up to date. Checked just now.");
  });

  it('downloads and installs from the same button', () => {
    expect(at({ status: 'available', version: '0.2.0' }).button).toMatchObject({ label: 'Download', action: 'download', primary: true });
    expect(at({ status: 'ready', version: '0.2.0' })).toEqual({
      text: 'Version 0.2.0 is ready to install.',
      button: { label: 'Restart to update', action: 'install', primary: true, disabled: false },
    });
  });

  it('says why a check failed and lets the user retry', () => {
    expect(at({ status: 'error', kind: 'offline' }).text).toBe("Couldn't check for updates: you're offline.");
    expect(at({ status: 'error', kind: 'failed' }).button).toMatchObject({ label: 'Try again', action: 'check' });
  });
});
