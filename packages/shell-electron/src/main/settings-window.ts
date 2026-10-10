import { BrowserWindow, shell } from 'electron';
import { logger } from './log';
import { preloadPath, rendererUrl } from './paths';

const log = logger('settings-window');

/** Settings and first-run setup. Created on demand; a normal focusable window. */
export class SettingsWindow {
  private win: BrowserWindow | null = null;

  get window(): BrowserWindow | null {
    return this.win && !this.win.isDestroyed() ? this.win : null;
  }

  isOwnWindow(id: number): boolean {
    return this.window?.webContents.id === id;
  }

  /** `hash` selects a tab ("keys", "models", ...) or "setup" for first-run setup. */
  open(hash?: string): void {
    const existing = this.window;
    if (existing) {
      if (hash) void existing.webContents.executeJavaScript(`location.hash = ${JSON.stringify(hash)}`);
      if (existing.isMinimized()) existing.restore();
      existing.show();
      existing.focus();
      return;
    }
    const win = new BrowserWindow({
      width: 920,
      height: 680,
      minWidth: 720,
      minHeight: 520,
      show: false,
      title: 'Glossly',
      autoHideMenuBar: true,
      webPreferences: {
        preload: preloadPath(),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    win.setMenu(null);
    win.once('ready-to-show', () => win.show());
    win.on('closed', () => {
      if (this.win === win) this.win = null;
    });
    // Links ("Get a key") open in the default browser, never inside the app.
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https:\/\//.test(url)) void shell.openExternal(url);
      return { action: 'deny' };
    });
    win.webContents.on('will-navigate', (e, url) => {
      if (url.split('#')[0] !== rendererUrl('settings')) e.preventDefault();
    });
    this.win = win;
    win.loadURL(rendererUrl('settings', hash)).catch((e: Error) => log.error('failed to load', { message: e.message.slice(0, 200) }));
  }

  send(channel: string, payload: unknown): void {
    const w = this.window;
    if (w) w.webContents.send(channel, payload);
  }
}
