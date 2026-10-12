import { Menu, nativeImage, Tray } from 'electron';
import { appIcoPath, appIconPath } from './paths';

/**
 * The Glass app icon (decision 41), the same as the taskbar's. On Windows the .ico lets the tray
 * pick its size (16 to 32 px by display scale); elsewhere the PNG is scaled down.
 */
function trayIcon(): Electron.NativeImage {
  if (process.platform === 'win32') return nativeImage.createFromPath(appIcoPath());
  return nativeImage.createFromPath(appIconPath()).resize({ width: 16, height: 16 });
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
