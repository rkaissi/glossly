import { writeFileSync } from 'node:fs';
import { clipboard, dialog, ipcMain, type IpcMainInvokeEvent } from 'electron';
import { aliasKindOf, type ActionId, type AliasKind, type CommitmentStatus, type InvokeArgs, type InvokeChannel, type InvokeResult, type PersonCard, type PromiseSaveRow, type SetSettingResult, type SettingsKey } from '@glossly/core';
import type { Capture } from './capture';
import type { HotkeyManager } from './hotkey';
import { logger } from './log';
import type { Overlay } from './overlay';
import type { Services } from './services';
import type { SettingsWindow } from './settings-window';

const log = logger('ipc');

const ACTIONS: readonly ActionId[] = ['ask', 'save', 'reply', 'who', 'promises', 'visualize'];
const TABS = ['profile', 'people', 'keys', 'models', 'general', 'data', 'metrics'] as const;
const ALIAS_KINDS: readonly AliasKind[] = ['email', 'handle', 'name'];
const STATUSES: readonly CommitmentStatus[] = ['open', 'done', 'dropped'];
const MAX_CLIPBOARD = 1_000_000;

export interface IpcDeps {
  services: Services;
  overlay: Overlay;
  capture: Capture;
  settingsWindow: SettingsWindow;
  hotkey: HotkeyManager;
  /** Pushes the settings view to every window. */
  broadcastSettings: () => void;
  /** Tells every window that people or commitments changed. */
  broadcastPeople: () => void;
}

const num = (v: unknown): number => {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error('Invalid argument');
  return v;
};
const str = (v: unknown, max = 10_000): string => {
  if (typeof v !== 'string' || v.length > max) throw new Error('Invalid argument');
  return v;
};
const optStr = (v: unknown, max = 10_000): string | undefined => (v === undefined || v === null || v === '' ? undefined : str(v, max));
const obj = (v: unknown): Record<string, unknown> => {
  if (typeof v !== 'object' || v === null) throw new Error('Invalid argument');
  return v as Record<string, unknown>;
};

export function registerIpc(deps: IpcDeps): void {
  const { services, overlay, capture, settingsWindow, hotkey, broadcastSettings, broadcastPeople } = deps;
  const people = services.people;

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

  // ---- What did I promise ----
  handle('promises:extract', (a) => capture.extractPromises(num(a.sessionId)));
  handle('promises:save', (a) => {
    if (!Array.isArray(a.rows) || a.rows.length > 20) throw new Error('Invalid rows');
    const rows = a.rows.map((raw): PromiseSaveRow => {
      const r = obj(raw);
      const owner = str(r.owner, 5);
      if (owner !== 'me' && owner !== 'them') throw new Error('Invalid owner');
      const due = r.due_at === null ? null : str(r.due_at, 40);
      if (due !== null && !/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?([+-]\d{2}:\d{2}|Z)?)?$/.test(due)) throw new Error('Invalid date');
      const p = r.person === null ? null : obj(r.person);
      const person: PromiseSaveRow['person'] =
        p === null ? null : p.kind === 'existing' ? { kind: 'existing', id: str(p.id, 100) } : p.kind === 'new' ? { kind: 'new', name: str(p.name, 100) } : null;
      return { owner, text: str(r.text, 500), due_at: due, person };
    });
    const r = capture.savePromises(num(a.sessionId), rows);
    broadcastPeople();
    return r;
  });

  // ---- people ----
  handle('who:get', (a) => capture.who(num(a.sessionId)));
  /** Runs a change, tells every window, and returns the person's overlay card. */
  const changed = (personId: string): PersonCard => {
    broadcastPeople();
    const card = people.card(personId);
    if (!card) throw new Error('That person no longer exists.');
    return card;
  };
  handle('people:list', (a) => people.list(optStr(a?.query, 200) ?? ''));
  handle('people:card', (a) => people.card(str(a.personId, 100), { interactions: 20, items: 20 }));
  handle('people:create', (a) => {
    const aliases = [
      ...(optStr(a.email, 200) ? [{ kind: 'email' as const, value: str(a.email, 200) }] : []),
      ...(optStr(a.handle, 100) ? [{ kind: 'handle' as const, value: str(a.handle, 100) }] : []),
    ];
    const p = people.create({ name: str(a.name, 200), note: optStr(a.note, 2000) ?? null, aliases });
    log.info('person created', { aliases: aliases.length });
    return changed(p.id);
  });
  handle('people:confirm-same', (a) => {
    const id = str(a.personId, 100);
    for (const [kind, v] of [['name', a.name], ['email', a.email], ['handle', a.handle]] as const) {
      const value = optStr(v, 200);
      // Quietly skips an alias someone else already has; the user can sort that out in the record.
      if (value) {
        try {
          people.addAlias(id, kind, value);
        } catch (e) {
          if ((e as Error).name !== 'AliasTakenError') throw e;
        }
      }
    }
    return changed(id);
  });
  handle('people:update', (a) => {
    const id = str(a.personId, 100);
    people.update(id, { ...(a.name !== undefined && { name: str(a.name, 200) }), ...(a.note !== undefined && { note: a.note === null ? null : str(a.note, 2000) }) });
    return changed(id);
  });
  handle('people:alias-add', (a) => {
    const id = str(a.personId, 100);
    const value = str(a.value, 200);
    const kind = a.kind ? (str(a.kind, 10) as AliasKind) : aliasKindOf(value);
    if (!ALIAS_KINDS.includes(kind)) throw new Error('Invalid alias kind');
    people.addAlias(id, kind, value);
    return changed(id);
  });
  handle('people:alias-remove', (a) => {
    const id = str(a.personId, 100);
    const kind = str(a.kind, 10) as AliasKind;
    if (!ALIAS_KINDS.includes(kind)) throw new Error('Invalid alias kind');
    people.removeAlias(id, kind, str(a.value, 200));
    return changed(id);
  });
  handle('people:merge', (a) => {
    const keep = str(a.keepId, 100);
    people.merge(keep, str(a.dropId, 100));
    log.info('people merged');
    return changed(keep);
  });
  handle('people:delete', (a) => {
    people.delete(str(a.personId, 100));
    log.info('person deleted');
    broadcastPeople();
  });
  handle('commitments:list', (a) => {
    const status = optStr(a?.status, 10) as CommitmentStatus | undefined;
    if (status && !STATUSES.includes(status)) throw new Error('Invalid status');
    return people.commitments(status ? { status } : {});
  });
  handle('commitments:set-status', (a) => {
    const status = str(a.status, 10) as CommitmentStatus;
    if (!STATUSES.includes(status)) throw new Error('Invalid status');
    people.setCommitmentStatus(str(a.id, 100), status);
    broadcastPeople();
  });

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
    broadcastPeople();
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
    const tab = a?.tab && (TABS as readonly string[]).includes(a.tab) ? a.tab : undefined;
    const personId = tab === 'people' ? optStr(a?.personId, 100) : undefined;
    settingsWindow.open(personId ? `people/${encodeURIComponent(personId)}` : tab);
  });
  handle('setup:try-it', (a, e) => {
    if (!settingsWindow.isOwnWindow(e.sender.id)) throw new Error('Settings window only');
    settingsWindow.setTryIt(obj(a).active === true);
  });
}
