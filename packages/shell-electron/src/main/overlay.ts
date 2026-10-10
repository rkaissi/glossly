import { EventEmitter } from 'node:events';
import { BrowserWindow, screen } from 'electron';
import type { OverlayMode, OverlayState, Placement, Rect, Size } from '@glossly/core';
import { logger } from './log';
import { preloadPath, rendererUrl } from './paths';
import { hwndFromBuffer } from './view';

const log = logger('overlay');

/**
 * Window sizes in DIP. The renderer reports its real size for the bar and panel. The bar and
 * panel widths match the UI's fixed width (packages/ui overlay.css), so the controls on the
 * right never shift when slots 3 and 4 fill in.
 */
export const SIZES = {
  pill: { w: 168, h: 40 },
  dot: { w: 16, h: 16 },
  bar: { w: 560, h: 40 },
  panel: { w: 560, h: 300 },
} satisfies Record<Exclude<OverlayMode, 'hidden'>, Size>;

const LIMITS = { minW: 120, maxW: 680, minH: 16, maxH: 640 };

export const HIDDEN_STATE: OverlayState = {
  sessionId: 0,
  mode: 'hidden',
  placement: null,
  keyboard: false,
  hasSelection: false,
  wordCount: 0,
  siteKey: null,
  debug: null,
  slots: null,
  badges: [],
  panel: null,
  notice: null,
};

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

/**
 * The pill, bar, and panel share one window, created once at launch and kept hidden. It is
 * shown with showInactive() and never takes focus unless `focus()` is called (hotkey path,
 * or an action that needs typing).
 */
export class Overlay extends EventEmitter<{ blur: [] }> {
  readonly win: BrowserWindow;
  private state: OverlayState = HIDDEN_STATE;
  private focused = false;
  private loaded: Promise<void>;

  constructor() {
    super();
    this.win = new BrowserWindow({
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      focusable: false,
      alwaysOnTop: true,
      hasShadow: false,
      width: SIZES.bar.w,
      height: SIZES.bar.h,
      webPreferences: {
        preload: preloadPath(),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        spellcheck: false,
        backgroundThrottling: false,
      },
    });
    this.win.setAlwaysOnTop(true, 'pop-up-menu');
    this.win.setMenu(null);
    this.win.on('blur', () => {
      if (this.focused) this.emit('blur');
    });
    this.win.webContents.on('render-process-gone', (_e, d) => {
      log.error('overlay renderer gone', { reason: d.reason });
      this.loaded = this.load();
    });
    this.loaded = this.load();
  }

  private async load(): Promise<void> {
    try {
      await this.win.loadURL(rendererUrl('overlay'));
    } catch (e) {
      log.error('overlay failed to load', { message: (e as Error).message.slice(0, 200) });
    }
  }

  whenLoaded(): Promise<void> {
    return this.loaded;
  }

  get current(): OverlayState {
    return this.state;
  }

  get isVisible(): boolean {
    return this.state.mode !== 'hidden' && this.win.isVisible();
  }

  /** The overlay asked for focus (it may not have it yet, see `osFocused`). */
  get hasFocus(): boolean {
    return this.focused;
  }

  /** Windows actually gave the overlay the foreground. */
  get osFocused(): boolean {
    return !this.win.isDestroyed() && this.win.isFocused();
  }

  bounds(): Rect {
    const b = this.win.getBounds();
    return { x: b.x, y: b.y, w: b.width, h: b.height };
  }

  isOwnWindow(id: number): boolean {
    return this.win.webContents.id === id;
  }

  /** Pushes new state; shows, moves, or hides the window to match. */
  update(state: OverlayState, rect?: Rect): void {
    this.state = state;
    if (!this.win.isDestroyed()) this.win.webContents.send('overlay:state', state);
    if (state.mode === 'hidden') {
      this.hideWindow();
      return;
    }
    if (rect) this.win.setBounds({ x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.w), height: Math.round(rect.h) });
    if (!this.win.isVisible()) {
      if (this.focused) this.win.show();
      else this.win.showInactive();
    }
  }

  patch(p: Partial<OverlayState>, rect?: Rect): void {
    this.update({ ...this.state, ...p }, rect);
  }

  /** Lets the overlay take keyboard focus. Only for the hotkey path or an action that needs typing. */
  focus(): void {
    this.focused = true;
    this.win.setFocusable(true);
    // On Windows, setFocusable rebuilds the window styles and the taskbar button comes back.
    this.win.setSkipTaskbar(true);
    if (!this.win.isVisible()) this.win.show();
    this.win.focus();
    this.win.webContents.focus();
  }

  private hideWindow(): void {
    this.win.hide();
    if (this.focused) {
      this.focused = false;
      this.win.setFocusable(false);
      this.win.setSkipTaskbar(true);
    }
  }

  /** The renderer measured its content. Keeps the edge next to the selection fixed. */
  resize(sessionId: number, w: number, h: number): void {
    const s = this.state;
    if (sessionId !== s.sessionId || (s.mode !== 'bar' && s.mode !== 'panel')) return;
    if (!Number.isFinite(w) || !Number.isFinite(h)) return;
    const cur = this.bounds();
    const nw = Math.round(clamp(w, LIMITS.minW, LIMITS.maxW));
    const nh = Math.round(clamp(h, LIMITS.minH, LIMITS.maxH));
    if (nw === cur.w && nh === cur.h) return;
    const area = screen.getDisplayMatching({ x: cur.x, y: cur.y, width: cur.w, height: cur.h }).workArea;
    const above = s.placement?.side === 'above';
    let x = clamp(cur.x, area.x, area.x + area.width - nw);
    let y = above ? cur.y + cur.h - nh : cur.y;
    y = clamp(y, area.y, area.y + area.height - nh);
    x = Math.round(x);
    const rect = { x, y: Math.round(y), w: nw, h: nh };
    const placement: Placement | null = s.placement ? { ...s.placement, rect } : null;
    this.state = { ...s, placement };
    this.win.setBounds({ x: rect.x, y: rect.y, width: rect.w, height: rect.h });
  }

  /** Native HWND as a number, for the helper's restore_focus. */
  nativeHandle(): number {
    return hwndFromBuffer(this.win.getNativeWindowHandle());
  }
}
