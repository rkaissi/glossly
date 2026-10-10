import { randomUUID } from 'node:crypto';
import { app, screen, type WebContents } from 'electron';
import {
  HelperError,
  LlmError,
  LlmStructuredDecision,
  Router,
  ask,
  countWords,
  gateApp,
  gateAutoSelection,
  isoNow,
  mayCopyFallback,
  placeBar,
  placePill,
  siteKeyFor,
  type ActionId,
  type AppMode,
  type AskErrorEvent,
  type CommandResult,
  type ContainerContext,
  type HelperEvent,
  type OverlayState,
  type Point,
  type Rect,
  type RouteResult,
  type SaveDone,
  type SelectionPayload,
  type SelectionContext,
  type Trigger,
} from '@glossly/core';
import type { HelperManager } from './helper-manager';
import { errorInfo, logger } from './log';
import { HIDDEN_STATE, SIZES, type Overlay } from './overlay';
import type { Services } from './services';
import { actionForSlot, contains, distanceToRect, growFrom, isAvailable, mergeRoute, slotsView } from './view';

const log = logger('capture');

const WATCH_INTERVAL_MS = 80;
const MAX_SELECTION_CHARS = 20_000;

type Foreground = CommandResult<'foreground'>;

interface Session {
  id: number;
  trigger: Trigger;
  /** performance.now() at the trigger. */
  t0: number;
  fg: Foreground | null;
  /** Null for the "nothing selected" state. */
  selection: SelectionPayload | null;
  /** Selection bounds and end point, in DIP. */
  bounds: Rect;
  anchor: Point;
  siteKey: string | null;
  tier1Read: boolean;
  /** Tier 2, read once when the user first clicks Ask or Save. */
  container: Promise<ContainerContext | null> | null;
  route: RouteResult | null;
  routeCtl: AbortController | null;
  asks: Map<string, AbortController>;
  timings: Record<string, number>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ms = (t: number) => Math.round(performance.now() - t);

function toDipRect(r: Rect): Rect {
  const d = screen.screenToDipRect(null, { x: r.x, y: r.y, width: r.w, height: r.h });
  return { x: d.x, y: d.y, w: d.width, h: d.height };
}

function toDipPoint(p: Point): Point {
  return screen.screenToDipPoint(p);
}

function workArea(p: Point): Rect {
  const a = screen.getDisplayNearestPoint({ x: Math.round(p.x), y: Math.round(p.y) }).workArea;
  return { x: a.x, y: a.y, w: a.width, h: a.height };
}

function cursorRect(p: Point): Rect {
  return { x: Math.round(p.x) - 1, y: Math.round(p.y) - 10, w: 2, h: 20 };
}

const toContext = (s: SelectionPayload): SelectionContext => ({
  text: s.text,
  context_before: s.context_before,
  context_after: s.context_after,
  source_app: s.source_app,
  window_title: s.window_title,
  is_editable: s.is_editable,
});

/**
 * The selection session: the auto pill and hotkey paths, expand and routing, action clicks
 * with tier-2 context, and Ask and Save. Main owns the selection; renderers refer to it by id.
 */
export class Capture {
  private session: Session | null = null;
  private nextSessionId = 1;
  /** Bumped by every mouse press, so an older auto capture still in flight is dropped. */
  private autoGen = 0;
  private watchTimer: ReturnType<typeof setInterval> | null = null;
  private inputWatch = false;
  /** Set while focus is handed to the source app to read tier 2 on the hotkey path. */
  private bouncing = false;

  /**
   * `captureSource` returns the HWND of the one Glossly window that may be read (the setup's
   * "Try it" step), or null. Every other Glossly window, the overlay included, is ignored.
   */
  constructor(
    private readonly helper: HelperManager,
    private readonly overlay: Overlay,
    private readonly services: Services,
    private readonly captureSource: () => number | null = () => null,
  ) {
    helper.on('event', (ev) => this.onHelperEvent(ev));
    helper.on('down', () => {
      this.inputWatch = false;
    });
    overlay.on('blur', () => {
      if (!this.bouncing && this.session) this.close('blur');
    });
  }

  get state(): OverlayState {
    return this.overlay.current;
  }

  private get settings() {
    return this.services.settings;
  }

  private ownPids(): Set<number> {
    const pids = new Set(app.getAppMetrics().map((m) => m.pid));
    if (this.helper.pid) pids.add(this.helper.pid);
    return pids;
  }

  private isOwn(fg: Foreground): boolean {
    return this.ownPids().has(fg.pid) && fg.handle !== this.captureSource();
  }

  /** The "Don't show here" key; none for Glossly's own Try-it window. */
  private siteKey(fg: Foreground): string | null {
    return fg.handle === this.captureSource() ? null : siteKeyFor({ process_name: fg.process_name, title: fg.title });
  }

  private current(id: number): Session | null {
    return this.session && this.session.id === id ? this.session : null;
  }

  // ---- helper events ----

  private onHelperEvent(ev: HelperEvent): void {
    switch (ev.event) {
      case 'mouse_down': {
        this.autoGen++;
        if (!this.overlay.isVisible || this.overlay.hasFocus) return;
        if (!contains(this.overlay.bounds(), toDipPoint(ev))) this.close('click_outside');
        return;
      }
      case 'mouse_up': {
        if (!ev.drag && !ev.double) return;
        const p = toDipPoint(ev);
        if (this.overlay.isVisible && contains(this.overlay.bounds(), p)) return;
        void this.autoTrigger(ev, p);
        return;
      }
      case 'wheel':
      case 'keyboard_activity':
        if (this.overlay.isVisible && !this.overlay.hasFocus) this.close(ev.event);
        return;
      default:
        return;
    }
  }

  // ---- auto pill path ----

  private async autoTrigger(physical: Point, p: Point): Promise<void> {
    const gen = ++this.autoGen;
    const t0 = performance.now();
    const timings: Record<string, number> = {};
    const stale = () => gen !== this.autoGen;
    const settings = this.settings;
    try {
      let t = performance.now();
      const fg = await this.helper.request('foreground');
      timings.foreground = ms(t);
      if (stale() || this.isOwn(fg)) return;
      const appId = { process_name: fg.process_name, title: fg.title };
      if (!gateApp(appId, 'auto', settings).ok) return;

      t = performance.now();
      const sel = await this.helper.request('selection', { max_chars: MAX_SELECTION_CHARS });
      timings.selection = ms(t);
      if (stale()) return;
      if (!gateAutoSelection(sel, appId, settings).ok) return;

      const wait = settings.capture.pillDelayMs - (performance.now() - t0);
      if (wait > 0) await sleep(wait);
      timings.wait = Math.max(0, Math.round(wait));
      if (stale()) return;

      const physBounds = sel.bounds ?? cursorRect(physical);
      t = performance.now();
      const popups = await this.helper
        .request('popups_near', { bounds: physBounds, exclude_pids: [...this.ownPids()] })
        .catch(() => ({ popups: [] }));
      timings.popups_near = ms(t);
      if (stale()) return;

      const bounds = toDipRect(physBounds);
      const placement = placePill({
        selection: bounds,
        anchor: p,
        obstacles: popups.popups.map((o) => toDipRect(o.bounds)),
        size: SIZES.pill,
        workArea: workArea(p),
      });
      timings.total = ms(t0);

      this.endSession();
      const session: Session = {
        id: this.nextSessionId++,
        trigger: 'auto',
        t0,
        fg,
        selection: {
          text: sel.text,
          context_before: '',
          context_after: '',
          source_app: fg.process_name,
          window_title: fg.title,
          captured_at: isoNow(),
          method: sel.method,
          trigger: 'auto',
          is_editable: sel.is_editable,
          foreground_handle: fg.handle,
        },
        bounds,
        anchor: p,
        siteKey: this.siteKey(fg),
        tier1Read: false,
        container: null,
        route: null,
        routeCtl: null,
        asks: new Map(),
        timings,
      };
      this.session = session;
      this.overlay.update(
        {
          ...HIDDEN_STATE,
          sessionId: session.id,
          mode: placement.mode,
          placement,
          hasSelection: true,
          wordCount: countWords(sel.text),
          siteKey: session.siteKey,
          debug: this.debugFor(session),
        },
        placement.rect,
      );
      this.services.metrics.record('pill_shown', { method: sel.method, ms: timings.total, side: placement.side });
      this.startWatch();
    } catch (e) {
      if (!(e instanceof HelperError)) log.error('auto capture failed', errorInfo(e));
    }
  }

  // ---- hotkey path ----

  async hotkey(): Promise<void> {
    this.services.metrics.record('hotkey');
    const s = this.session;
    // A visible pill or unfocused bar: expand it and take focus.
    if (s && this.overlay.isVisible && !this.overlay.hasFocus && s.selection) {
      this.stopWatch();
      if (this.state.mode !== 'bar' && this.state.mode !== 'panel') await this.expand(s.id, true);
      if (this.current(s.id)) {
        this.focusOverlay();
        this.overlay.patch({ keyboard: true });
      }
      return;
    }
    // A bar that never got the OS focus (Windows refused it) falls through to a fresh capture.
    if (s && this.overlay.hasFocus && this.overlay.osFocused) {
      this.close('hotkey_toggle');
      return;
    }

    const t0 = performance.now();
    const timings: Record<string, number> = {};
    const settings = this.settings;
    const cursor = screen.getCursorScreenPoint();
    let fg: Foreground | null = null;
    let notice: string | null = null;
    let selection: SelectionPayload | null = null;
    let physBounds: Rect | null = null;

    try {
      let t = performance.now();
      fg = await this.helper.request('foreground');
      timings.foreground = ms(t);
      if (this.isOwn(fg)) fg = null;
    } catch (e) {
      notice = this.helperNotice(e);
    }

    if (fg) {
      const appId = { process_name: fg.process_name, title: fg.title };
      const gate = gateApp(appId, 'hotkey', settings);
      if (!gate.ok) {
        notice = gate.reason === 'blocked' ? 'Glossly never reads from this app.' : 'Glossly is off in this app.';
      } else {
        try {
          let t = performance.now();
          let sel: CommandResult<'selection'> | null = null;
          let password = false;
          try {
            sel = await this.helper.request('selection', { max_chars: MAX_SELECTION_CHARS });
            password = sel.is_password;
          } catch (e) {
            if (e instanceof HelperError && e.code === 'password_field') password = true;
            else if (e instanceof HelperError && (e.code === 'closed' || e.code === 'timeout')) throw e;
          }
          timings.selection = ms(t);
          let text = sel?.text ?? '';
          let method: SelectionPayload['method'] = sel?.method ?? 'uia';
          if (sel?.bounds && text.trim()) physBounds = sel.bounds;

          if (password) notice = 'This is a password field. Nothing was read.';
          else if (mayCopyFallback(sel, appId, settings)) {
            t = performance.now();
            const cf = await this.helper.request('copy_fallback', { timeout_ms: settings.capture.copyTimeoutMs });
            timings.copy_fallback = ms(t);
            text = cf.text;
            method = 'copy';
          }

          if (text.trim() && !password) {
            selection = {
              text,
              context_before: '',
              context_after: '',
              source_app: fg.process_name,
              window_title: fg.title,
              captured_at: isoNow(),
              method,
              trigger: 'hotkey',
              is_editable: sel?.is_editable ?? false,
              foreground_handle: fg.handle,
            };
          }
        } catch (e) {
          notice = this.helperNotice(e);
        }
      }
    }

    this.endSession();
    const bounds = physBounds ? toDipRect(physBounds) : cursorRect(cursor);
    const session: Session = {
      id: this.nextSessionId++,
      trigger: 'hotkey',
      t0,
      fg,
      selection,
      bounds,
      anchor: physBounds ? { x: bounds.x + bounds.w, y: bounds.y + bounds.h } : cursor,
      siteKey: fg ? this.siteKey(fg) : null,
      tier1Read: false,
      container: null,
      route: null,
      routeCtl: null,
      asks: new Map(),
      timings,
    };
    this.session = session;

    if (selection) {
      await this.readTier1(session);
      if (!this.current(session.id)) return;
    }
    const placement = placeBar({ selection: session.bounds, anchor: session.anchor, obstacles: [], size: SIZES.bar, workArea: workArea(session.anchor) });
    const quick = selection ? this.router().quick(toContext(selection)) : null;
    session.route = quick;
    timings.total = ms(t0);
    this.focusOverlay();
    this.overlay.update(
      {
        ...HIDDEN_STATE,
        sessionId: session.id,
        mode: 'bar',
        placement,
        keyboard: true,
        hasSelection: Boolean(selection),
        wordCount: selection ? countWords(selection.text) : 0,
        siteKey: session.siteKey,
        debug: this.debugFor(session),
        slots: quick ? slotsView(quick, 'rules') : null,
        notice: notice ?? this.takeNotice(),
      },
      placement.rect,
    );
    this.services.metrics.record('bar_shown', { trigger: 'hotkey', ms: timings.total, has_selection: Boolean(selection) });
    if (selection) void this.routeModel(session);
  }

  /**
   * Focuses the overlay. Windows may refuse the foreground change (for example while the
   * source app is in its Alt menu mode); then the helper forces it with restore_focus.
   */
  private focusOverlay(): void {
    this.overlay.focus();
    setTimeout(() => {
      if (!this.overlay.hasFocus || this.overlay.osFocused || this.bouncing) return;
      void this.helper
        .request('restore_focus', { handle: this.overlay.nativeHandle() })
        .then((r) => {
          log.info('overlay focus forced', { method: r.method });
          if (this.overlay.hasFocus) this.overlay.focus();
        })
        .catch(() => log.warn('overlay could not take focus'));
    }, 80);
  }

  private helperNotice(e: unknown): string {
    if (e instanceof HelperError && (e.code === 'closed' || e.code === 'timeout')) return 'The capture helper is not responding. It restarts on its own.';
    return 'Could not read the selection.';
  }

  // ---- expand and routing ----

  /** Pill to bar: tier-1 context, rules paint at once, the model fills slots 3 and 4. */
  async expand(sessionId: number, viaHotkey = false): Promise<void> {
    const s = this.current(sessionId);
    if (!s || !s.selection) return;
    if (this.state.mode === 'bar' || this.state.mode === 'panel') return;
    const t = performance.now();
    await this.readTier1(s);
    if (!this.current(sessionId)) return;
    const quick = this.router().quick(toContext(s.selection));
    s.route = quick;
    const from = this.state.placement;
    const area = workArea(s.anchor);
    const rect =
      from && from.mode === 'pill'
        ? growFrom(from.rect, from.side, SIZES.bar, area)
        : placeBar({ selection: s.bounds, anchor: s.anchor, obstacles: [], size: SIZES.bar, workArea: area }).rect;
    const side = from?.mode === 'pill' ? from.side : rect.y >= s.bounds.y + s.bounds.h ? 'below' : 'above';
    s.timings.expand = ms(t);
    this.overlay.patch(
      {
        mode: 'bar',
        placement: { mode: 'pill', side, rect },
        slots: slotsView(quick, 'rules'),
        debug: this.debugFor(s),
        notice: this.takeNotice(),
      },
      rect,
    );
    this.services.metrics.record('bar_shown', { trigger: viaHotkey ? 'hotkey' : 'auto', ms: ms(s.t0) });
    void this.routeModel(s);
  }

  private async readTier1(s: Session): Promise<void> {
    if (s.tier1Read || !s.selection) return;
    s.tier1Read = true;
    const n = this.settings.capture.contextChars;
    const t = performance.now();
    try {
      const ctx = await this.helper.request('context', { before: n, after: n });
      s.selection.context_before = ctx.before;
      s.selection.context_after = ctx.after;
    } catch {
      /* no tier 1 (copy fallback, or the app lost its selection): route on the selection alone */
    }
    s.timings.context = ms(t);
  }

  private router(): Router {
    const sv = this.services;
    return new Router({
      decision: sv.llm.hasModel('decision') ? new LlmStructuredDecision(sv.llm) : null,
      settings: () => sv.settings,
      collections: () => sv.collections(),
      people: () => sv.store.listKnownPeople(),
    });
  }

  private async routeModel(s: Session): Promise<void> {
    if (!s.selection) return;
    const ctl = new AbortController();
    s.routeCtl = ctl;
    try {
      const r = await this.router().route(toContext(s.selection), ctl.signal);
      if (!this.current(s.id) || ctl.signal.aborted) return;
      s.route = r;
      s.timings.route = Math.round(r.ms);
      const prev = this.state.slots;
      const next = slotsView(r, r.fallback ? 'rules_fallback' : 'model');
      this.overlay.patch({ slots: prev ? mergeRoute(prev, next) : next, debug: this.debugFor(s) });
      this.services.metrics.record('router_done', {
        provider: r.decisions.provider,
        fallback: r.fallback ?? 'none',
        ms: Math.round(r.ms),
        content_type: r.decisions.content_type,
      });
    } catch (e) {
      log.error('route failed', errorInfo(e));
    } finally {
      if (s.routeCtl === ctl) s.routeCtl = null;
    }
  }

  // ---- actions ----

  async run(sessionId: number, target: { slot: 1 | 2 | 3 | 4 } | { action: ActionId }): Promise<void> {
    const s = this.current(sessionId);
    if (!s) return;
    const action = 'slot' in target ? actionForSlot(this.state.slots, target.slot) : target.action;
    if (!action) return;
    if (!s.selection && action !== 'ask') return;
    this.stopWatch();
    this.services.metrics.record('action_clicked', { action, ms: ms(s.t0), trigger: s.trigger });

    if (isAvailable(action) && s.selection) await this.readTier2(s);
    if (!this.current(sessionId)) return;

    const from = this.state.placement?.rect ?? this.overlay.bounds();
    const side = this.state.placement?.side ?? 'below';
    const rect = growFrom(from, side, SIZES.panel, workArea(s.anchor));
    if (isAvailable(action) && !this.overlay.hasFocus) this.focusOverlay();
    this.overlay.patch(
      { mode: 'panel', panel: action, placement: { mode: 'pill', side, rect }, keyboard: this.overlay.hasFocus, debug: this.debugFor(s) },
      rect,
    );
  }

  /**
   * Tier 2 is read when the user first clicks an action. The helper reads from the focused
   * element, so if the overlay holds focus (hotkey path) focus goes back to the source window
   * for the read and then returns to the overlay.
   */
  private async readTier2(s: Session): Promise<void> {
    if (s.container || !s.selection) return;
    const read = async (): Promise<ContainerContext | null> => {
      try {
        const c = await this.helper.request('context_container', { max_chars: this.settings.capture.containerChars });
        return { text: c.text, selection_start: c.selection_start, selection_length: c.selection_length, source: c.source };
      } catch {
        return null;
      }
    };
    const t = performance.now();
    if (!this.overlay.hasFocus || !s.fg || s.selection.method === 'copy') {
      s.container = s.selection.method === 'copy' ? Promise.resolve(null) : read();
    } else {
      this.bouncing = true;
      s.container = (async () => {
        try {
          await this.helper.request('restore_focus', { handle: s.fg!.handle });
          return await read();
        } catch {
          return null;
        } finally {
          await this.helper.request('restore_focus', { handle: this.overlay.nativeHandle() }).catch(() => {});
          this.overlay.focus();
          this.bouncing = false;
        }
      })();
    }
    const c = await s.container;
    s.timings.context_container = ms(t);
    s.timings.tier2 = c?.source === 'container' ? 1 : 0;
  }

  back(sessionId: number): void {
    const s = this.current(sessionId);
    if (!s || this.state.mode !== 'panel') return;
    this.cancelAsks(s);
    const from = this.state.placement?.rect ?? this.overlay.bounds();
    const side = this.state.placement?.side ?? 'below';
    const rect = growFrom(from, side, SIZES.bar, workArea(s.anchor));
    this.overlay.patch({ mode: 'bar', panel: null, placement: { mode: 'pill', side, rect } }, rect);
  }

  dontShowHere(sessionId: number): { key: string; mode: AppMode } | null {
    const s = this.current(sessionId);
    if (!s?.siteKey) return null;
    const key = s.siteKey;
    this.services.setSetting('appModes', { ...this.settings.appModes, [key]: 'hotkey' });
    this.close('dont_show_here');
    log.info('app set to hotkey-only');
    return { key, mode: 'hotkey' };
  }

  // ---- Ask and Save ----

  startAsk(sessionId: number, question: string, target: WebContents): { requestId: string } {
    const requestId = randomUUID();
    const s = this.current(sessionId);
    const send = <T>(channel: string, payload: T) => {
      if (!target.isDestroyed()) target.send(channel, payload);
    };
    const fail = (code: AskErrorEvent['code'], message: string) => send<AskErrorEvent>('ask:error', { requestId, code, message });

    const q = question.trim();
    if (!s || (!s.selection && !q)) {
      setTimeout(() => fail('no_selection', 'Select some text or type a question first.'), 0);
      return { requestId };
    }
    const ctl = new AbortController();
    s.asks.set(requestId, ctl);
    const selection: SelectionPayload = s.selection ?? {
      text: '',
      context_before: '',
      context_after: '',
      source_app: s.fg?.process_name ?? '',
      window_title: s.fg?.title ?? '',
      captured_at: isoNow(),
      method: 'uia',
      trigger: s.trigger,
      is_editable: false,
      foreground_handle: s.fg?.handle ?? 0,
    };

    void (async () => {
      const t = performance.now();
      let firstMs: number | null = null;
      try {
        const container = (await s.container) ?? null;
        const r = ask(this.services.llm, this.settings, { selection, container, question: q, related: [] }, ctl.signal);
        for await (const text of r.textStream) {
          firstMs ??= ms(t);
          send('ask:chunk', { requestId, text });
        }
        const model = await r.model;
        send('ask:done', { requestId, model });
        this.services.metrics.record('ask_done', { first_token_ms: firstMs ?? -1, total_ms: ms(t) });
      } catch (e) {
        const code: AskErrorEvent['code'] = e instanceof LlmError ? e.code : ctl.signal.aborted ? 'aborted' : 'provider';
        const message = e instanceof LlmError ? e.message : 'The model call failed.';
        if (code !== 'aborted') this.services.metrics.record('ask_error', { code, ...(e instanceof LlmError && e.statusCode && { status: e.statusCode }) });
        fail(code, message);
      } finally {
        s.asks.delete(requestId);
      }
    })();
    return { requestId };
  }

  cancelAsk(requestId: string): void {
    this.session?.asks.get(requestId)?.abort();
  }

  private cancelAsks(s: Session): void {
    for (const c of s.asks.values()) c.abort();
    s.asks.clear();
  }

  async save(sessionId: number, collection: string, why?: string): Promise<SaveDone> {
    const s = this.current(sessionId);
    if (!s?.selection) throw new Error('Nothing to save.');
    const name = collection.trim() || s.route?.decisions.best_collection || 'Notes';
    const container = (await s.container) ?? null;
    const r = this.services.save.save({ selection: s.selection, container, collection: name, why });
    return { itemId: r.item.id, collection: name, undoUntil: r.undoUntil };
  }

  // ---- closing ----

  close(reason: string): void {
    const s = this.session;
    if (!s) {
      if (this.overlay.isVisible) this.overlay.update(HIDDEN_STATE);
      return;
    }
    const hadFocus = this.overlay.hasFocus;
    this.endSession();
    this.overlay.update({ ...HIDDEN_STATE, sessionId: s.id });
    if (hadFocus && s.fg && reason !== 'blur') {
      void this.helper.request('restore_focus', { handle: s.fg.handle }).catch(() => {});
    }
  }

  private endSession(): void {
    const s = this.session;
    this.stopWatch();
    if (!s) return;
    s.routeCtl?.abort();
    this.cancelAsks(s);
    this.session = null;
  }

  // ---- hide-on-activity watch (pill and unfocused bar) ----

  private startWatch(): void {
    this.stopWatch();
    void this.setInputWatch(true);
    this.watchTimer = setInterval(() => {
      if (!this.overlay.isVisible || this.overlay.hasFocus) return;
      const d = distanceToRect(screen.getCursorScreenPoint(), this.overlay.bounds());
      if (d > this.settings.capture.hideDistancePx) this.close('mouse_away');
    }, WATCH_INTERVAL_MS);
  }

  private stopWatch(): void {
    if (this.watchTimer) clearInterval(this.watchTimer);
    this.watchTimer = null;
    void this.setInputWatch(false);
  }

  private async setInputWatch(enabled: boolean): Promise<void> {
    if (this.inputWatch === enabled || !this.helper.isReady) return;
    this.inputWatch = enabled;
    try {
      await this.helper.request('input_watch', { enabled });
    } catch {
      this.inputWatch = !enabled;
    }
  }

  // ---- state helpers ----

  private debugFor(s: Session): OverlayState['debug'] {
    if (!this.settings.debugView) return null;
    const sel = s.selection;
    return {
      text: sel?.text ?? '',
      context_before: sel?.context_before ?? '',
      context_after: sel?.context_after ?? '',
      method: sel?.method ?? 'uia',
      trigger: s.trigger,
      source_app: s.fg?.process_name ?? '',
      window_title: s.fg?.title ?? '',
      is_editable: sel?.is_editable ?? false,
      timings: { ...s.timings },
    };
  }

  /** The one-time notice (e.g. a role's model went away), cleared once shown. */
  private takeNotice(): string | null {
    const n = this.settings.pendingNotice;
    if (n) this.services.setSetting('pendingNotice', null);
    return n;
  }
}
