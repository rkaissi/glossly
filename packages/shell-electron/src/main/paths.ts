import { existsSync } from 'node:fs';
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

export const preloadPath = () => join(outMain, '../preload/index.cjs');
export const embedWorkerPath = () => join(outMain, 'embed-worker.js');

/** URL for a renderer page: the Vite dev server in dev, the built file otherwise. */
export function rendererUrl(page: 'overlay' | 'settings', hash = ''): string {
  const dev = process.env.ELECTRON_RENDERER_URL;
  const h = hash ? `#${hash}` : '';
  if (dev) return `${dev}/${page}.html${h}`;
  return `file://${join(outMain, `../renderer/${page}.html`).replace(/\\/g, '/')}${h}`;
}

export const userDataPath = (...parts: string[]) => join(app.getPath('userData'), ...parts);
