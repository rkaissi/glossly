import { app } from 'electron';
import { Capture } from './capture';
import { HelperManager } from './helper-manager';
import { HotkeyManager } from './hotkey';
import { registerIpc } from './ipc';
import { errorInfo, initLog, logger } from './log';
import { Overlay } from './overlay';
import { userDataPath } from './paths';
import { Services } from './services';
import { SettingsWindow } from './settings-window';
import { runSmoke } from './smoke';
import { createTray } from './tray';

const log = logger('main');

app.setAppUserModelId('com.glossly.app');
if (!app.requestSingleInstanceLock()) app.quit();

let quitting = false;

async function main(): Promise<void> {
  await app.whenReady();
  initLog(userDataPath('logs', 'main.log'));
  log.info('starting', { version: app.getVersion(), electron: process.versions.electron });

  const services = new Services();
  const overlay = new Overlay();
  const helper = new HelperManager();
  const settingsWindow = new SettingsWindow();
  const capture = new Capture(helper, overlay, services, () => settingsWindow.captureSourceHandle());
  const hotkey = new HotkeyManager(() => {
    capture.hotkey().catch((e: unknown) => log.error('hotkey failed', errorInfo(e)));
  });

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
  services.embed.on('status', (s) => settingsWindow.send('embed:progress', s));

  registerIpc({ services, overlay, capture, settingsWindow, hotkey, broadcastSettings });

  helper.start();
  if (!hotkey.register(services.settings.hotkey)) {
    services.setSetting('pendingNotice', `The hotkey ${services.settings.hotkey} is taken by another app. Pick another in Settings.`);
  }

  const { refresh } = createTray({
    openSettings: () => settingsWindow.open(),
    debugView: () => services.settings.debugView,
    setDebugView: (on) => services.setSetting('debugView', on),
    quit: () => app.quit(),
  });
  services.on('settings', refresh);

  if (services.embed.downloaded || services.settings.firstRunComplete) services.embed.start();
  services.refreshIfStale().catch((e: unknown) => log.warn('catalog refresh failed', errorInfo(e)));
  if (!services.settings.firstRunComplete && !process.env.GLOSSLY_SMOKE) settingsWindow.open('setup');

  app.on('second-instance', () => settingsWindow.open());
  // A tray app: closing the settings window must not quit.
  app.on('window-all-closed', () => {});
  app.on('before-quit', (e) => {
    if (quitting) return;
    e.preventDefault();
    quitting = true;
    capture.close('quit');
    hotkey.dispose();
    helper.stop();
    services
      .shutdown()
      .catch(() => {})
      .finally(() => app.exit(0));
  });

  if (process.env.GLOSSLY_SMOKE) void runSmoke({ helper, capture, services });
}

main().catch((e: unknown) => {
  log.error('startup failed', { ...errorInfo(e), message: (e as Error)?.message?.slice(0, 300) });
  app.exit(1);
});
