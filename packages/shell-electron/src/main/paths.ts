import { existsSync } from 'node:fs';
import { release } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { app } from 'electron';

const outMain = fileURLToPath(new URL('.', import.meta.url));

export const isDev = !app.isPackaged;

export function helperPath(): string {
  if (process.env.GLOSSLY_HELPER_PATH) return process.env.GLOSSLY_HELPER_PATH;
  if (app.isPackaged) return join(process.resourcesPath, 'helper', 'glossly-helper.exe');
  return resolve(app.getAppPath(), '../../helpers/windows/bin/Debug/net10.0-windows/glossly-helper.exe');
}

export function helperExists(): boolean {
  return existsSync(helperPath());
}

/** The Glass app icon (decision 41) for windows and the taskbar; packaging adds the installer's .ico (Step 22). */
export function appIconPath(): string {
  if (app.isPackaged) return join(process.resourcesPath, 'icon.png');
  return resolve(app.getAppPath(), 'resources/icon.png');
}

/**
 * The same icon as a multi-size .ico, for the taskbar. Windows takes a grouped window's taskbar
 * icon from its relaunch icon (an .ico or .exe), not the window icon, so without it a dev build
 * shows electron.exe's.
 */
export function appIcoPath(): string {
  if (app.isPackaged) return join(process.resourcesPath, 'icon.ico');
  return resolve(app.getAppPath(), 'resources/icon.ico');
}

export const preloadPath = () => join(outMain, '../preload/index.cjs');
export const embedWorkerPath = () => join(outMain, 'embed-worker.js');

/** URL for a renderer page: the Vite dev server in dev, the built file otherwise. */
export function rendererUrl(page: 'overlay' | 'settings', hash = '', query = ''): string {
  const dev = process.env.ELECTRON_RENDERER_URL;
  const h = (query ? `?${query}` : '') + (hash ? `#${hash}` : '');
  if (dev) return `${dev}/${page}.html${h}`;
  return `file://${join(outMain, `../renderer/${page}.html`).replace(/\\/g, '/')}${h}`;
}

/**
 * Windows 11 22H2 (build 22621) and later draw `backgroundMaterial` (acrylic, mica). Dev
 * builds can turn it off with GLOSSLY_NO_MATERIAL=1 to check the fallback look.
 */
export function hasWindowMaterial(): boolean {
  if (process.platform !== 'win32') return false;
  if (!app.isPackaged && process.env.GLOSSLY_NO_MATERIAL === '1') return false;
  return Number(release().split('.')[2] ?? 0) >= 22621;
}

export const userDataPath =(...parts: string[]) => join(app.getPath('userData'), ...parts);
