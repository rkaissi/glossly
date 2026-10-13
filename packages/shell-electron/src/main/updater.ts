import { EventEmitter } from 'node:events';
import { app, Notification } from 'electron';
import electronUpdater from 'electron-updater';
import { isoNow, updateErrorCode, updateErrorKind } from '@glossly/core';
import type { UpdateState, UpdateView } from '@glossly/core/api';
import { logger } from './log';

const { autoUpdater } = electronUpdater;
const log = logger('updates');

const FIRST_CHECK_MS = 30_000;
const CHECK_EVERY_MS = 6 * 3_600_000;

/**
 * Updates from the release feed electron-builder writes (`app-update.yml`, decision 70): checks
 * after start and every 6 hours, downloads when `autoUpdate` is on, and installs at the end of
 * Glossly's own shutdown. Glossly ends with `app.exit()`, which skips the `quit` event
 * electron-updater installs on, so `finish` runs the installer instead. Dev builds have no feed.
 */
export class Updater extends EventEmitter<{ state: [UpdateView] }> {
  private state: UpdateState = app.isPackaged ? { status: 'idle' } : { status: 'unsupported' };
  private restart = false;
  private lastPercent = -1;
  /** Kept so the toast isn't collected before it's clicked. */
  private toast: Notification | null = null;

  constructor(private readonly autoDownload: () => boolean) {
    super();
  }

  get view(): UpdateView {
    return { current: app.getVersion(), state: this.state };
  }

  start(): void {
    if (this.state.status === 'unsupported') return;
    autoUpdater.logger = null;
    autoUpdater.autoDownload = this.autoDownload();
    autoUpdater.autoInstallOnAppQuit = false;
    autoUpdater.on('checking-for-update', () => this.set({ status: 'checking' }));
    autoUpdater.on('update-not-available', () => this.set({ status: 'none', checkedAt: isoNow() }));
    autoUpdater.on('update-available', (info) => {
      log.info('update available', { version: info.version });
      this.set(autoUpdater.autoDownload ? { status: 'downloading', version: info.version, percent: 0 } : { status: 'available', version: info.version });
    });
    autoUpdater.on('download-progress', (p) => {
      const percent = Math.floor(p.percent);
      if (percent === this.lastPercent || !('version' in this.state)) return;
      this.lastPercent = percent;
      this.set({ status: 'downloading', version: this.state.version, percent });
    });
    autoUpdater.on('update-downloaded', (info) => {
      log.info('update downloaded', { version: info.version });
      this.set({ status: 'ready', version: info.version });
      this.notify(info.version);
    });
    autoUpdater.on('error', (e) => this.failed(e));
    setTimeout(() => void this.check(), FIRST_CHECK_MS).unref();
    setInterval(() => void this.check(), CHECK_EVERY_MS).unref();
  }

  /** Follows the `autoUpdate` setting; turning it on downloads an update already found. */
  syncAutoDownload(): void {
    if (this.state.status === 'unsupported') return;
    autoUpdater.autoDownload = this.autoDownload();
    if (autoUpdater.autoDownload && this.state.status === 'available') void this.download();
  }

  async check(): Promise<UpdateView> {
    const s = this.state.status;
    if (s === 'unsupported' || s === 'checking' || s === 'downloading' || s === 'ready') return this.view;
    // A failure also comes as the 'error' event, which sets the state; here it's only caught.
    await autoUpdater.checkForUpdates().catch(() => {});
    return this.view;
  }

  async download(): Promise<void> {
    if (this.state.status !== 'available') return;
    this.set({ status: 'downloading', version: this.state.version, percent: 0 });
    await autoUpdater.downloadUpdate().catch(() => {});
  }

  /** "Restart to update": the caller quits, and `finish` installs and starts Glossly again. */
  requestRestart(): boolean {
    if (this.state.status !== 'ready') return false;
    this.restart = true;
    return true;
  }

  /**
   * The last step of shutdown: runs a downloaded update's installer silently (starting Glossly
   * again after "Restart to update") and lets the app quit. False when there's nothing to install.
   */
  finish(): boolean {
    if (this.state.status !== 'ready') return false;
    log.info('installing update', { version: this.state.version, restart: this.restart });
    autoUpdater.quitAndInstall(true, this.restart);
    // quitAndInstall quits only when the installer started.
    setTimeout(() => app.exit(0), 5_000).unref();
    return true;
  }

  private failed(e: unknown): void {
    const kind = updateErrorKind(e);
    log.warn('update check failed', { kind, code: updateErrorCode(e) });
    // An update found but not downloaded can still be offered again on the next check.
    this.set(kind === 'none' ? { status: 'none', checkedAt: isoNow() } : { status: 'error', kind });
  }

  private notify(version: string): void {
    if (!Notification.isSupported()) return;
    const n = new Notification({ title: `Glossly ${version} is ready`, body: 'Restart Glossly to update. It also updates the next time you quit.' });
    n.on('click', () => {
      if (this.requestRestart()) app.quit();
    });
    n.show();
    this.toast = n;
  }

  private set(state: UpdateState): void {
    this.state = state;
    if (state.status !== 'downloading') this.lastPercent = -1;
    this.emit('state', this.view);
  }
}
