import { Menu, nativeImage, Tray } from 'electron';

/** A 32x32 tray icon drawn in code: a violet disc with a white highlight bar. */
function trayIcon(): Electron.NativeImage {
  const size = 32;
  const buf = Buffer.alloc(size * size * 4);
  const c = (size - 1) / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x - c, y - c);
      const alpha = Math.max(0, Math.min(1, 15.5 - d));
      const bar = y >= 14 && y <= 18 && x >= 8 && x <= 23;
      const i = (y * size + x) * 4;
      // BGRA
      buf[i] = bar ? 255 : 0xf5;
      buf[i + 1] = bar ? 255 : 0x5e;
      buf[i + 2] = bar ? 255 : 0x6d;
      buf[i + 3] = Math.round(alpha * 255);
    }
  }
  return nativeImage.createFromBitmap(buf, { width: size, height: size }).resize({ width: 16, height: 16 });
}

export interface TrayActions {
  openSettings: () => void;
  debugView: () => boolean;
  setDebugView: (on: boolean) => void;
  quit: () => void;
}

export function createTray(actions: TrayActions): { tray: Tray; refresh: () => void } {
  const tray = new Tray(trayIcon());
  tray.setToolTip('Glossly');
  const refresh = () =>
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: 'Settings', click: actions.openSettings },
        { label: 'Debug view in the bar', type: 'checkbox', checked: actions.debugView(), click: (i) => actions.setDebugView(i.checked) },
        { type: 'separator' },
        { label: 'Quit Glossly', click: actions.quit },
      ]),
    );
  refresh();
  tray.on('click', actions.openSettings);
  return { tray, refresh };
}
