import { writeFileSync } from 'node:fs';
import { clipboard, dialog, ipcMain, type IpcMainInvokeEvent } from 'electron';
import type { ActionId, InvokeArgs, InvokeChannel, InvokeResult, SetSettingResult, SettingsKey } from '@glossly/core';
import type { Capture } from './capture';
import type { HotkeyManager } from './hotkey';
import { logger } from './log';
import type { Overlay } from './overlay';
import type { Services } from './services';
import type { SettingsWindow } from './settings-window';

const log = logger('ipc');

const ACTIONS: readonly ActionId[] = ['ask', 'save', 'reply', 'who', 'promises', 'visualize'];
const TABS = ['keys', 'models', 'general', 'data', 'metrics'] as const;
const MAX_CLIPBOARD = 1_000_000;

export interface IpcDeps {
  services: Services;
  overlay: Overlay;
  capture: Capture;
  settingsWindow: SettingsWindow;
  hotkey: HotkeyManager;
  /** Pushes the settings view to every window. */
  broadcastSettings: () => void;
}

const num = (v: unknown): number => {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error('Invalid argument');
  return v;
};
const str = (v: unknown, max = 10_000): string => {
  if (typeof v !== 'string' || v.length > max) throw new Error('Invalid argument');
  return v;
};
const obj = (v: unknown): Record<string, unknown> => {
  if (typeof v !== 'object' || v === null) throw new Error('Invalid argument');
  return v as Record<string, unknown>;
};

export function registerIpc(deps: IpcDeps): void {
  const { services, overlay, capture, settingsWindow, hotkey, broadcastSettings } = deps;

  const trusted = (e: IpcMainInvokeEvent) => overlay.isOwnWindow(e.sender.id) || settingsWindow.isOwnWindow(e.sender.id);

  function handle<C extends InvokeChannel>(
    channel: C,
    fn: (args: InvokeArgs<C>, e: IpcMainInvokeEvent) => InvokeResult<C> | Promise<InvokeResult<C>>,
  ): void {
    ipcMain.handle(channel, async (e, args: InvokeArgs<C>) => {
      if (!trusted(e)) throw new Error('Untrusted sender');
      try {
        return await fn(args, e);
      } catch (err) {
        log.warn('handler failed', { channel, name: (err as Error).name });
        throw err;
      }
    });
  }

  // ---- overlay ----
  handle('overlay:get', () => capture.state);
  handle('overlay:resize', (a) => overlay.resize(num(a.sessionId), num(a.w), num(a.h)));
  handle('bar:expand', (a) => capture.expand(num(a.sessionId)));
  handle('bar:run', (a) => {
    const o = obj(a);
    const sessionId = num(o.sessionId);
    if ('slot' in o) {
      const slot = num(o.slot);
      if (slot !== 1 && slot !== 2 && slot !== 3 && slot !== 4) throw new Error('Invalid slot');
      return capture.run(sessionId, { slot });
    }
    const action = str(o.action, 20) as ActionId;
    if (!ACTIONS.includes(action)) throw new Error('Invalid action');
    return capture.run(sessionId, { action });
  });
  handle('bar:dont-show-here', (a) => {
    const r = capture.dontShowHere(num(a.sessionId));
    if (r) broadcastSettings();
    return r;
  });
  handle('bar:back', (a) => capture.back(num(a.sessionId)));
  handle('bar:close', (a) => {
    if (num(a.sessionId) === capture.state.sessionId) capture.close('user');
  });

  // ---- Ask and Save ----
  handle('ask:start', (a, e) => capture.startAsk(num(a.sessionId), str(a.question ?? '', 2000), e.sender));
  handle('ask:cancel', (a) => capture.cancelAsk(str(a.requestId, 100)));
  handle('save:save', (a) => capture.save(num(a.sessionId), str(a.collection, 100), a.why === undefined ? undefined : str(a.why, 2000)));
  handle('save:setWhy', (a) => services.save.setWhy(str(a.itemId, 100), str(a.why, 2000)));
  handle('save:undo', (a) => ({ undone: services.save.undo(str(a.itemId, 100)) }));
  handle('clipboard:write', (a) => clipboard.writeText(str(a.text, MAX_CLIPBOARD)));

  // ---- settings ----
  handle('settings:get', () => services.view());
  handle('settings:set', (a): SetSettingResult => {
    const key = str(a.key, 50) as SettingsKey;
    if (key === 'roles') throw new Error('Use roles:set');
    if (key === 'hotkey') {
      const err = hotkey.change(str(a.value, 100));
      if (err) return { settings: services.settings, error: err };
    }
    try {
      services.setSetting(key, a.value);
    } catch {
      return { settings: services.settings, error: 'That value is not valid.' };
    }
    broadcastSettings();
    return { settings: services.settings };
  });
  handle('keys:add', async (a) => {
    const r = await services.addKey(str(a.provider, 30), str(a.key, 500));
    broadcastSettings();
    return r;
  });
  handle('keys:test', async (a) => {
    const r = await services.testKey(str(a.provider, 30));
    broadcastSettings();
    return r;
  });
  handle('keys:remove', (a) => {
    services.removeKey(str(a.provider, 30));
    broadcastSettings();
  });
  handle('models:refresh', async () => {
    const r = await services.refreshModels();
    broadcastSettings();
    return r;
  });
  handle('roles:set', (a) => {
    const role = str(a.role, 20);
    if (role !== 'fast' && role !== 'chat' && role !== 'decision') throw new Error('Invalid role');
    const model = a.model === null ? null : str(a.model, 200);
    const fallback = a.fallback === null ? null : str(a.fallback, 200);
    const roles = services.setRole({ role, model, fallback });
    broadcastSettings();
    return roles;
  });

  // ---- data ----
  handle('data:export', async () => {
    const date = new Date().toISOString().slice(0, 10);
    const parent = settingsWindow.window;
    const opts = { defaultPath: `glossly-export-${date}.json`, filters: [{ name: 'JSON', extensions: ['json'] }] };
    const r = parent ? await dialog.showSaveDialog(parent, opts) : await dialog.showSaveDialog(opts);
    if (r.canceled || !r.filePath) return null;
    writeFileSync(r.filePath, JSON.stringify(services.store.exportAll(), null, 2));
    log.info('exported');
    return { path: r.filePath };
  });
  handle('data:delete-all', async () => {
    capture.close('delete_all');
    await services.deleteAll();
    log.info('all data deleted');
    broadcastSettings();
  });
  handle('settings:reset', () => {
    capture.close('reset_settings');
    services.resetSettings();
    if (hotkey.change(services.settings.hotkey)) log.warn('default hotkey unavailable after reset');
    log.info('settings reset');
    broadcastSettings();
  });
  handle('metrics:summary', (a) => services.metrics.summary(Math.min(Math.max(Math.trunc(num(a.days)), 1), 90)));
  handle('embed:status', () => services.embed.getStatus());
  handle('embed:download', () => services.embed.start());
  handle('settings:open', (a, e) => {
    // From the overlay (its menu, or "Add a key"): the bar's job is done; close it so it
    // doesn't sit on top of the settings window.
    if (overlay.isOwnWindow(e.sender.id)) capture.close('settings');
    const tab = a?.tab;
    settingsWindow.open(tab && (TABS as readonly string[]).includes(tab) ? tab : undefined);
  });
  handle('setup:try-it', (a, e) => {
    if (!settingsWindow.isOwnWindow(e.sender.id)) throw new Error('Settings window only');
    settingsWindow.setTryIt(obj(a).active === true);
  });
}
