import { app } from 'electron';
import { Capture } from './capture';
import { HelperManager } from './helper-manager';
import { HotkeyManager, SaveHotkey } from './hotkey';
import { registerIpc } from './ipc';
import { errorInfo, initLog, logger } from './log';
import { Overlay } from './overlay';
import { Reminders } from './reminders';
import { APP_ID, dataDirArg, LOGIN_ARG, userDataPath } from './paths';
import { Services } from './services';
import { Updater } from './updater';
import { SettingsWindow } from './settings-window';
import { runSmoke } from './smoke';
import { createTray } from './tray';

const log = logger('main');

app.setAppUserModelId(APP_ID);
/** Windows started Glossly at sign-in: no window, just the tray (decision 71). */
const atLogin = process.argv.includes(LOGIN_ARG);
// A throwaway profile (the single-instance lock is per profile): `--data-dir=<folder>` in any
// build, so the installed app can be tested without the real data (decision 69), or
// GLOSSLY_USER_DATA in dev builds. Dev builds can also skip the helper and hotkey, so a test
// instance runs next to the real one.
const dataDir = dataDirArg(process.argv) ?? (!app.isPackaged ? process.env.GLOSSLY_USER_DATA : undefined);
if (dataDir) app.setPath('userData', dataDir);
const noCapture = !app.isPackaged && process.env.GLOSSLY_NO_CAPTURE === '1';
const primary = app.requestSingleInstanceLock();

let quitting = false;

async function main(): Promise<void> {
  await app.whenReady();
  initLog(userDataPath('logs', 'main.log'));
  log.info('starting', { version: app.getVersion(), electron: process.versions.electron });

  const services = new Services();
  const overlay = new Overlay();
  overlay.keyHints = () => services.settings.keyHints;
  const helper = new HelperManager();
  // Windows 11 rounding for the acrylic overlay; the helper sets DWM's corner preference.
  overlay.useCorners(async (corners) => {
    const r = await helper.request('window_corners', { handle: overlay.nativeHandle(), corners });
    if (!r.applied) log.warn('overlay corners not applied', { corners });
  });
  helper.on('ready', () => overlay.refreshCorners());
  const settingsWindow = new SettingsWindow();
  const capture = new Capture(
    helper,
    overlay,
    services,
    () => settingsWindow.captureSourceHandle(),
    (step) => settingsWindow.send('setup:tried', { step }),
  );
  const hotkey = new HotkeyManager(() => {
    capture.hotkey().catch((e: unknown) => log.error('hotkey failed', errorInfo(e)));
  });
  const saveHotkey = new SaveHotkey(() => {
    capture.saveHotkey().catch((e: unknown) => log.error('save hotkey failed', errorInfo(e)));
  });
  /** Matches the save hotkey to the Save mode. A fallback shortcut is stored; a failure becomes a notice. */
  const syncSaveHotkey = (): string | null => {
    if (noCapture) return null;
    const r = saveHotkey.sync(services.settings);
    if (r.accelerator && r.accelerator !== services.settings.saveHotkey) services.setSetting('saveHotkey', r.accelerator);
    if (r.error) services.setSetting('pendingNotice', r.error);
    return r.error ?? null;
  };

  let pending = false;
  const broadcastSettings = () => {
    if (pending) return;
    pending = true;
    setImmediate(() => {
      pending = false;
      const view = services.view();
      settingsWindow.send('settings:changed', view);
      if (!overlay.win.isDestroyed()) overlay.win.webContents.send('settings:changed', view);
    });
  };
  services.on('settings', broadcastSettings);
  const broadcastPeople = () => {
    settingsWindow.send('people:changed', {});
    if (!overlay.win.isDestroyed()) overlay.win.webContents.send('people:changed', {});
  };
  services.embed.on('status', (s) => settingsWindow.send('embed:progress', s));
  const updater = new Updater(() => services.settings.autoUpdate);
  updater.on('state', (v) => settingsWindow.send('updates:state', v));
  services.on('settings', () => updater.syncAutoDownload());

  registerIpc({ services, overlay, capture, settingsWindow, hotkey, saveHotkey, syncSaveHotkey, broadcastSettings, broadcastPeople, updater });

  if (noCapture) log.info('capture off (GLOSSLY_NO_CAPTURE)');
  else {
    helper.start();
    if (!hotkey.register(services.settings.hotkey)) {
      // ipc.ts clears it when a new hotkey works, by this opening.
      services.setSetting('pendingNotice', `The hotkey ${services.settings.hotkey} is taken by another app. Pick another in Settings.`);
    }
    syncSaveHotkey();
  }

  const { refresh } = createTray({
    openSettings: () => settingsWindow.open(),
    debugView: () => services.settings.debugView,
    setDebugView: (on) => services.setSetting('debugView', on),
    quit: () => app.quit(),
  });
  services.on('settings', refresh);

  const reminders = new Reminders(services, (tab) => settingsWindow.open(tab));
  reminders.start();
  updater.start();

  if (services.embed.downloaded || services.settings.firstRunComplete) services.embed.start();
  services.refreshIfStale().catch((e: unknown) => log.warn('catalog refresh failed', errorInfo(e)));
  setInterval(() => services.pruneCallLog(), 86_400_000).unref();
  // Opening Glossly opens its window, like any app; at sign-in it starts quietly in the tray.
  syncLoginItem(services.settings.openAtLogin);
  services.on('settings', () => syncLoginItem(services.settings.openAtLogin));
  if (!services.settings.firstRunComplete && !process.env.GLOSSLY_SMOKE) settingsWindow.open('setup');
  else if (!atLogin && !process.env.GLOSSLY_SMOKE) settingsWindow.open();

  app.on('second-instance', () => settingsWindow.open());
  // A tray app: closing the settings window must not quit.
  app.on('window-all-closed', () => {});
  app.on('before-quit', (e) => {
    if (quitting) return;
    e.preventDefault();
    quitting = true;
    // Glossly is on its way out, so an error now shouldn't stop it with Electron's error box
    // (seen once on "Restart to update"); log what it was instead.
    process.on('uncaughtException', (err) => {
      log.error('error while quitting', { ...errorInfo(err), message: err.message.slice(0, 200), at: err.stack?.split('\n')[1]?.trim().slice(0, 200) });
    });
    capture.close('quit');
    reminders.stop();
    hotkey.dispose();
    saveHotkey.dispose();
    helper.stop();
    services
      .shutdown()
      .catch(() => {})
      // A downloaded update installs on the way out (decision 70).
      .finally(() => {
        if (!updater.finish()) app.exit(0);
      });
  });

  if (process.env.GLOSSLY_SMOKE) void runSmoke({ helper, capture, services });
}

/**
 * Starts Glossly at sign-in, in the tray (decision 71): a Run entry for this user. Installed builds
 * only; a dev build would register electron.exe. Turning it off in Windows' Startup apps wins: Windows
 * keeps it off however often this is written.
 */
let loginItem: boolean | null = null;
function syncLoginItem(on: boolean): void {
  // A test profile (`--data-dir`) leaves it alone: a test run of a build outside the install
  // folder would point the user's real entry at that build.
  if (!app.isPackaged || dataDir || process.platform !== 'win32' || on === loginItem) return;
  loginItem = on;
  app.setLoginItemSettings({ openAtLogin: on, path: process.execPath, args: [LOGIN_ARG], name: 'Glossly' });
  log.info('login item', { on });
}

// A second instance must not open the shared database or touch settings.
if (!primary) {
  app.exit(0);
} else {
  main().catch((e: unknown) => {
    log.error('startup failed', { ...errorInfo(e), message: (e as Error)?.message?.slice(0, 300) });
    app.exit(1);
  });
}
