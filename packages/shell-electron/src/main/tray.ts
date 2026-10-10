import { Menu, nativeImage, nativeTheme, Tray } from 'electron';

/** Distance from p to the segment a-b. */
function segDist(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/**
 * Whether a point (in the mark's 24-unit grid, packages/ui icons.tsx GlosslyMark) is on the
 * Glossly mark: a text cursor (three strokes) and a four-point sparkle.
 */
function onMark(x: number, y: number): boolean {
  const r = 1.7; // half the stroke; heavier than the UI's 2-unit stroke so it holds at tray size
  const strokes: [number, number, number, number][] = [
    [8.5, 5, 8.5, 19],
    [5.5, 5, 11.5, 5],
    [5.5, 19, 11.5, 19],
  ];
  if (strokes.some(([ax, ay, bx, by]) => segDist(x, y, ax, ay, bx, by) <= r)) return true;
  // Sparkle: a four-point star centered at (18, 8), a little larger and fuller than in the UI.
  const dx = Math.abs(x - 18) / 5.5;
  const dy = Math.abs(y - 8) / 5.5;
  return dx ** 0.6 + dy ** 0.6 <= 1;
}

/**
 * A 32x32 tray icon drawn in code, monochrome: the Glossly mark (C1) cut into a near-black
 * disc, inverted when the system is dark. 4x4 supersampling keeps the edges smooth.
 */
function trayIcon(dark: boolean): Electron.NativeImage {
  const disc = dark ? 0xec : 0x1a;
  const mark = dark ? 0x1a : 0xff;
  const size = 32;
  const buf = Buffer.alloc(size * size * 4);
  const c = size / 2;
  // The mark's ink spans about x 4..23.5 and y 2.5..21 in its grid; center it in the disc.
  const scale = 23 / 24;
  const toGrid = (v: number, center: number) => (v - c) / scale + center;
  const n = 4;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let inDisc = 0;
      let inMark = 0;
      for (let sy = 0; sy < n; sy++) {
        for (let sx = 0; sx < n; sx++) {
          const px = x + (sx + 0.5) / n;
          const py = y + (sy + 0.5) / n;
          if (Math.hypot(px - c, py - c) > c) continue;
          inDisc++;
          if (onMark(toGrid(px, 13.5), toGrid(py, 12))) inMark++;
        }
      }
      const i = (y * size + x) * 4;
      const t = inDisc ? inMark / inDisc : 0;
      // BGRA, gray only.
      buf[i] = buf[i + 1] = buf[i + 2] = Math.round(disc + (mark - disc) * t);
      buf[i + 3] = Math.round((inDisc / (n * n)) * 255);
    }
  }
  // A 2x image (16 DIP): Windows scales it for the tray's real size (20 px at 125%).
  return nativeImage.createFromBitmap(buf, { width: size, height: size, scaleFactor: 2 });
}

export interface TrayActions {
  openSettings: () => void;
  debugView: () => boolean;
  setDebugView: (on: boolean) => void;
  quit: () => void;
}

export function createTray(actions: TrayActions): { tray: Tray; refresh: () => void } {
  const tray = new Tray(trayIcon(nativeTheme.shouldUseDarkColors));
  nativeTheme.on('updated', () => tray.setImage(trayIcon(nativeTheme.shouldUseDarkColors)));
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
