import { EventEmitter } from 'node:events';
import { BrowserWindow, screen } from 'electron';
import type { OverlayMode, OverlayState, Placement, Rect, Size } from '@glossly/core';
import { logger } from './log';
import { hasWindowMaterial, preloadPath, rendererUrl } from './paths';
import { fitOnScreen, hwndFromBuffer } from './view';

const log = logger('overlay');

/**
 * Window sizes in DIP. The pill is fixed (packages/ui overlay.css: menu 32, Ask 72, Save 80
 * in a 40 px row). The bar and panel start at these sizes and then fit their content: the
 * renderer reports its size and `resize()` grows the window rightward from its left edge,
 * so nothing on screen moves when slots 3 and 4 fill in.
 */
export const SIZES = {
  pill: { w: 200, h: 40 },
  /** The dot's window; the visible dot is smaller (placement `mark`). Windows' minimum is about 29x38. */
  dot: { w: 40, h: 40 },
  bar: { w: 200, h: 40 },
  panel: { w: 520, h: 300 },
  toast: { w: 260, h: 40 },
} satisfies Record<Exclude<OverlayMode, 'hidden'>, Size>;

/**
 * The widest the bar or panel can get: menu, Ask, Save, and two slots at the 172 px label
 * cap (644), plus room for a badge. Placement picks the left edge so this fits on screen.
 */
export const MAX_W = 680;

const LIMITS = { minW: 40, maxW: MAX_W, minH: 16, maxH: 640 };

/** DWM corner preference, set through the helper (Electron has no API for it). */
export type Corners = 'round' | 'default';

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
  saved: null,
};

/**
 * The pill, bar, and panel share one window, created once at launch and kept hidden. It is
 * shown with showInactive() and never takes focus unless `focus()` is called (hotkey path,
 * or an action that needs typing).
 */
export class Overlay extends EventEmitter<{ blur: [] }> {
  readonly win: BrowserWindow;
  private state: OverlayState = HIDDEN_STATE;
  private focused = false;
  private clickThrough = false;
  private loaded: Promise<void>;
  /** Windows 11 acrylic behind the pill, bar, and panel (Step 13.1 spike). */
  private readonly acrylic = hasWindowMaterial();
  /** What the window shows now: acrylic glass, or clear for the dot. */
  private material: 'glass' | 'clear' = 'glass';
  /** Acrylic comes back paler after the window was focused and hidden; re-applied on next show. */
  private materialStale = false;
  private corners: Corners | null = null;
  private setCorners: ((c: Corners) => Promise<void>) | null = null;

  constructor() {
    super();
    this.win = new BrowserWindow({
      show: false,
      frame: false,
      // Transparent keeps the bounds exact; acrylic still fills the whole window rect, and DWM
      // rounds it once the helper sets the corner preference.
      transparent: true,
      backgroundColor: '#00000000',
      ...(this.acrylic && { backgroundMaterial: 'acrylic' as const }),
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
      await this.win.loadURL(rendererUrl('overlay', '', this.acrylic ? 'material=acrylic' : ''));
    } catch (e) {
      log.error('overlay failed to load', { message: (e as Error).message.slice(0, 200) });
    }
  }

  whenLoaded(): Promise<void> {
    return this.loaded;
  }

  /** Wires the helper's window_corners; applied whenever the material changes. */
  useCorners(set: (c: Corners) => Promise<void>): void {
    this.setCorners = set;
    this.refreshCorners();
  }

  /** Sets the corner preference again (the helper just started, so an earlier try may have failed). */
  refreshCorners(): void {
    this.corners = null;
    this.applyCorners();
  }

  private applyCorners(): void {
    if (!this.acrylic || !this.setCorners) return;
    const want: Corners = this.material === 'glass' ? 'round' : 'default';
    if (want === this.corners) return;
    this.corners = want;
    this.setCorners(want).catch(() => {
      // Helper not ready or restarting: try again on the next change.
      if (this.corners === want) this.corners = null;
    });
  }

  /**
   * Acrylic for the pill, bar, and panel; clear for the dot, whose window is mostly
   * click-through and draws its own small circle. 'none' alone turns a transparent window
   * opaque white, so the clear background color is set again after it.
   */
  private setMaterial(glass: boolean): void {
    if (!this.acrylic) return;
    const want = glass ? 'glass' : 'clear';
    if (want === this.material && !(glass && this.materialStale)) return;
    this.win.setBackgroundMaterial('none');
    this.win.setBackgroundColor('#00000000');
    if (glass) this.win.setBackgroundMaterial('acrylic');
    this.material = want;
    if (glass) this.materialStale = false;
    this.applyCorners();
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

  /** The part that takes clicks: just the dot in dot mode, else the whole window. */
  hitBounds(): Rect {
    const p = this.state.placement;
    return this.state.mode === 'dot' && p?.mark ? p.mark : this.bounds();
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
    // Material changes go in before the window shows, so it never flashes the wrong look.
    this.setMaterial(state.mode !== 'dot');
    this.applyCorners();
    // In dot mode only the dot takes the mouse; moves are still forwarded so hovering it expands.
    const clickThrough = state.mode === 'dot';
    if (clickThrough !== this.clickThrough) {
      this.clickThrough = clickThrough;
      this.win.setIgnoreMouseEvents(clickThrough, { forward: true });
    }
    if (rect) {
      this.win.setBounds({ x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.w), height: Math.round(rect.h) });
      if (state.mode === 'dot') {
        const b = this.win.getBounds();
        const off = (a: number, e: number) => Math.abs(a - Math.round(e)) > 1;
        if (off(b.x, rect.x) || off(b.y, rect.y) || off(b.width, rect.w) || off(b.height, rect.h)) {
          log.warn('dot window resized by the OS', { x: b.x - rect.x, y: b.y - rect.y, w: b.width, h: b.height });
        }
      }
    }
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
      this.materialStale = true;
      this.focused = false;
      this.win.setFocusable(false);
      this.win.setSkipTaskbar(true);
    }
  }

  /**
   * The renderer measured its content. Keeps the left edge and the edge next to the selection
   * fixed, so the window only grows rightward and away from the selection. Placement already
   * left room for MAX_W on the right. If the content is still wider than the work area, the
   * window shrinks to fit instead of hanging off the screen.
   */
  resize(sessionId: number, w: number, h: number): void {
    const s = this.state;
    if (sessionId !== s.sessionId || (s.mode !== 'bar' && s.mode !== 'panel' && s.mode !== 'toast')) return;
    if (!Number.isFinite(w) || !Number.isFinite(h)) return;
    const cur = this.bounds();
    const display = screen.getDisplayMatching({ x: cur.x, y: cur.y, width: cur.w, height: cur.h }).workArea;
    const rect = fitOnScreen(
      cur,
      w,
      h,
      { x: display.x, y: display.y, w: display.width, h: display.height },
      s.placement?.side === 'above',
      LIMITS,
    );
    if (rect.w === cur.w && rect.h === cur.h && rect.x === cur.x && rect.y === cur.y) return;
    const placement: Placement | null = s.placement ? { ...s.placement, rect } : null;
    this.state = { ...s, placement };
    this.win.setBounds({ x: rect.x, y: rect.y, width: rect.w, height: rect.h });
  }

  /** Native HWND as a number, for the helper's restore_focus. */
  nativeHandle(): number {
    return hwndFromBuffer(this.win.getNativeWindowHandle());
  }
}
