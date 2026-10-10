import { randomUUID } from 'node:crypto';
import { app, clipboard, screen, type WebContents } from 'electron';
import {
  HelperError,
  LlmError,
  LlmStructuredDecision,
  Router,
  ask,
  classifyObstacles,
  countWords,
  detectInputFor,
  detectPeople,
  extractPromises,
  resolvePerson,
  savePromises,
  personBadges,
  whoFor,
  gateApp,
  gateAutoSelection,
  isoNow,
  learnKeyFor,
  foundAppToolbar,
  learnToolbarWait,
  mayCopyFallback,
  pillWait,
  reply,
  placeBar,
  placePill,
  pollForToolbar,
  siteKeyFor,
  type ActionId,
  type AppMode,
  type AskErrorEvent,
  type ClassifiedObstacle,
  type CommandResult,
  type ContainerContext,
  type HelperEvent,
  type ObstacleDebug,
  type OverlayState,
  type PillTiming,
  type PromiseSaveRow,
  type PromisesResult,
  type ReplyInsertResult,
  type ReplyStart,
  type ReplyTo,
  type Placement,
  type Point,
  type Rect,
  type RouteResult,
  type SaveDone,
  type SelectionPayload,
  type SelectionContext,
  type Trigger,
  type WhoView,
} from '@glossly/core';
import type { HelperManager } from './helper-manager';
import { errorInfo, logger } from './log';
import { HIDDEN_STATE, MAX_W, SIZES, type Overlay } from './overlay';
import type { Services } from './services';
import { actionForSlot, contains, distanceToRect, growFrom, isAvailable, mergeRoute, shouldHideOverlay, slotsView, type HideSignal } from './view';

const log = logger('capture');

const WATCH_INTERVAL_MS = 80;
const MAX_SELECTION_CHARS = 20_000;
/**
 * After the hotkey opens the bar, ignore the key that opened it, a cursor that is still far
 * from the selection, and a focus or foreground bounce. The helper reports that key as
 * keyboard_activity about 50 to 100 ms later, often while the bar is visible and not focused yet.
 */
const HOTKEY_SETTLE_MS = 500;

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
  placement: Placement['side'] | null;
  obstacles: ObstacleDebug[];
  pill: PillTiming | null;
  /** The running "What did I promise" extraction. */
  promisesCtl: AbortController | null;
  /** Who wrote the selected message, from the last extraction: their person id (exact match only) and whether it was the user. */
  author: { personId: string | null; isMe: boolean } | null;
  /** The latest Reply request: drafts done, and whether one was inserted or copied (else it counts as discarded). */
  reply: { requestId: string; ctl: AbortController; personId: string | null; done: boolean; used: boolean } | null;
}

/** How long the auto path waits for the helper's mouse-down snapshot if it is still being taken. */
const BASELINE_WAIT_MS = 100;

/** Synthetic obstacles above and below the selection, for checking the dot by hand (dev builds only). */
const FORCE_DOT = !app.isPackaged && process.env.GLOSSLY_FORCE_DOT === '1';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
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
  /** The session whose pill or dot is expanding (tier 1 is being read). */
  private expanding: Session | null = null;
  /** Epoch ms until which a hotkey-opened bar stays up. 0 when not settling. */
  private settleUntil = 0;

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
      if (!this.bouncing && this.session) this.activityHide('blur');
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
        const inside = this.overlay.isVisible && contains(this.overlay.hitBounds(), toDipPoint(ev));
        if (!this.overlay.isVisible || this.overlay.hasFocus) return;
        if (!inside) this.close('click_outside');
        return;
      }
      case 'mouse_up': {
        if (!ev.drag && !ev.double) return;
        const p = toDipPoint(ev);
        if (this.overlay.isVisible && contains(this.overlay.hitBounds(), p)) return;
        void this.autoTrigger(ev, p);
        return;
      }
      case 'wheel':
      case 'keyboard_activity':
        this.activityHide(ev.event);
        return;
      case 'foreground': {
        // The overlay belongs to the window the text was selected in: close it when another
        // app's window comes to the front. (A focused overlay already closes on blur.)
        const own = ev.handle === this.session?.fg?.handle || this.ownPids().has(ev.pid);
        this.activityHide('foreground', own);
        return;
      }
      default:
        return;
    }
  }

  // ---- auto pill path ----

  /**
   * The auto pill: read the selection, then check for the app's own selection toolbar from
   * about 100 ms after mouse-up until the app's wait is over (full where toolbars are known or
   * learned, short elsewhere), and show at once on the side away from any toolbar found. The
   * pill is placed once and never moves.
   */
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

      // What was on screen at this selection's mouse-down, taken by the helper on its own.
      t = performance.now();
      const exclude = [...this.ownPids()];
      const base = await this.helper.request('baseline', { exclude_pids: exclude, wait_ms: BASELINE_WAIT_MS }).catch(() => null);
      const before = base?.available ? base.popups : null;
      timings.baseline = ms(t);
      if (stale()) return;

      const physBounds = sel.bounds ?? cursorRect(physical);
      const wait = pillWait(appId, settings);
      const find = async () => {
        const r = await this.helper.request('popups_near', { bounds: physBounds, exclude_pids: exclude }).catch(() => ({ popups: [] }));
        return classifyObstacles(r.popups, before, physBounds);
      };
      let classified: ClassifiedObstacle[] = [];
      let checksMs = 0;
      const check = async () => {
        const tc = performance.now();
        classified = await find();
        timings.popups_near = ms(tc);
        checksMs += timings.popups_near;
        return FORCE_DOT || classified.some((o) => o.status === 'new');
      };
      const poll = await pollForToolbar({
        t0,
        waitMs: wait.ms,
        firstMs: settings.capture.pollStartMs,
        intervalMs: settings.capture.pollIntervalMs,
        check,
        stale,
        now: () => performance.now(),
        sleep,
      });
      if (!poll) return;
      timings.wait = poll.slept;
      timings.polls = poll.polls;
      timings.popups_total = checksMs;

      const bounds = toDipRect(physBounds);
      const obstacles = classified.filter((o) => o.status === 'new').map((o) => toDipRect(o.popup.bounds));
      if (FORCE_DOT) obstacles.push({ ...bounds, y: bounds.y - 80, h: 80 }, { ...bounds, y: bounds.y + bounds.h, h: 80 });
      const placement = placePill({
        selection: bounds,
        anchor: p,
        obstacles,
        size: SIZES.pill,
        growW: MAX_W,
        dotWindow: SIZES.dot,
        workArea: workArea(p),
      });
      timings.total = ms(t0);
      const obstacleInfo = classified.map((o): ObstacleDebug => {
        const r = toDipRect(o.popup.bounds);
        const { source, kind, class_name, process_name } = o.popup;
        return { source, kind, w: Math.round(r.w), h: Math.round(r.h), side: o.side, status: o.status, class_name, process_name };
      });

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
        placement: placement.side,
        obstacles: obstacleInfo,
        pill: { wait_ms: wait.ms, reason: wait.reason, polls: poll.polls, found: poll.found, baseline: before !== null },
        promisesCtl: null,
        author: null,
        reply: null,
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
      this.services.metrics.record('pill_shown', {
        method: sel.method,
        ms: timings.total,
        side: placement.side,
        wait_ms: wait.ms,
        wait_reason: wait.reason,
        polls: poll.polls,
        popups_ms: timings.popups_near ?? 0,
        baseline: before !== null,
        obstacles: obstacleInfo.filter((o) => o.status === 'new').length,
        ignored: obstacleInfo.filter((o) => o.status !== 'new').length,
        // e.g. o1 = "window.tool_window.320x48.below.new"
        ...Object.fromEntries(obstacleInfo.slice(0, 6).map((o, i) => [`o${i + 1}`, `${o.source}.${o.kind}.${o.w}x${o.h}.${o.side}.${o.status}`])),
      });
      if (obstacleInfo.length > 0) {
        log.info('pill obstacles', {
          side: placement.side,
          baseline: before !== null,
          obstacles: obstacleInfo.map((o) => `${o.source} ${o.kind} ${o.w}x${o.h} ${o.side} ${o.status} ${o.process_name} ${o.class_name}`),
        });
      }
      log.info('pill shown', {
        ms: timings.total,
        side: placement.side,
        wait_ms: wait.ms,
        reason: wait.reason,
        polls: poll.polls,
        found: poll.found,
        selection_ms: timings.selection,
        baseline_ms: timings.baseline,
        popups_ms: timings.popups_near,
        baseline: before !== null,
      });
      this.startWatch();

      // Only the app's own new toolbars teach its wait (see foundAppToolbar).
      const learnKey = wait.reason !== 'known' && session.siteKey !== null ? learnKeyFor(appId) : null;
      const fromApp = (found: ClassifiedObstacle[]) => foundAppToolbar(found, fg.process_name);
      if (learnKey && poll.found && fromApp(classified)) this.learnToolbar(learnKey, poll.at);
      else if (learnKey && wait.ms < settings.capture.pillDelayMs) {
        // The pill is up and never moves, but one check at the full wait teaches the next
        // selection here to wait for a toolbar that shows up later than the short wait.
        setTimeout(
          () => {
            if (!this.current(session.id)) return;
            const started = ms(t0);
            void find().then((late) => {
              if (fromApp(late)) this.learnToolbar(learnKey, started);
            });
          },
          Math.max(0, t0 + settings.capture.pillDelayMs - performance.now()),
        );
      }
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
      // Before the await: the hotkey's own keys are about to arrive as keyboard_activity.
      this.armHotkeySettle();
      this.stopWatch();
      if (this.state.mode !== 'bar' && this.state.mode !== 'panel') await this.expand(s.id, true);
      if (this.current(s.id)) {
        this.focusOverlay(true);
        this.overlay.patch({ keyboard: true });
      }
      return;
    }
    // A bar that never got the OS focus (Windows refused it) falls through to a fresh capture.
    if (s && this.overlay.hasFocus && this.overlay.osFocused) {
      this.close('hotkey_toggle');
      return;
    }
    this.armHotkeySettle();

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
      placement: null,
      obstacles: [],
      pill: null,
      promisesCtl: null,
      author: null,
      reply: null,
    };
    this.session = session;

    if (selection) {
      await this.readTier1(session);
      if (!this.current(session.id)) return;
    }
    const placement = placeBar({ selection: session.bounds, anchor: session.anchor, obstacles: [], size: SIZES.bar, growW: MAX_W, workArea: workArea(session.anchor) });
    const quick = selection ? this.router().quick(toContext(selection)) : null;
    session.route = quick;
    timings.total = ms(t0);
    this.focusOverlay(true);
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
        badges: this.badgesFor(session),
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
   * `settle` restarts the hotkey grace so a blur before that focus lands does not hide the bar.
   */
  private focusOverlay(settle = false): void {
    if (settle) this.armHotkeySettle();
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
    if (!s || !s.selection || this.expanding === s) return;
    if (this.state.mode === 'bar' || this.state.mode === 'panel') return;
    const t = performance.now();
    this.expanding = s;
    try {
      await this.readTier1(s);
    } finally {
      this.expanding = null;
    }
    if (!this.current(sessionId)) return;
    const quick = this.router().quick(toContext(s.selection));
    s.route = quick;
    const from = this.state.placement;
    const area = workArea(s.anchor);
    const rect =
      from && from.mode === 'pill'
        ? growFrom(from.rect, from.side, SIZES.bar, area)
        : placeBar({ selection: s.bounds, anchor: s.anchor, obstacles: [], size: SIZES.bar, growW: MAX_W, workArea: area }).rect;
    const side = from?.mode === 'pill' ? from.side : rect.y >= s.bounds.y + s.bounds.h ? 'below' : 'above';
    s.timings.expand = ms(t);
    if (viaHotkey) this.armHotkeySettle();
    this.overlay.patch(
      {
        mode: 'bar',
        placement: { mode: 'pill', side, rect },
        slots: slotsView(quick, 'rules'),
        badges: this.badgesFor(s),
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
      identity: () => sv.settings.identity,
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
      const routed = {
        provider: r.decisions.provider,
        fallback: r.fallback ?? 'none',
        ms: Math.round(r.ms),
        budget_ms: this.settings.router.decisionTimeoutMs,
      };
      this.services.metrics.record('router_done', { ...routed, content_type: r.decisions.content_type });
      log.info('routed', routed);
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
    // Never narrower than the bar it opens under; the renderer then reports the real size.
    const rect = growFrom(from, side, { w: Math.max(from.w, SIZES.panel.w), h: SIZES.panel.h }, workArea(s.anchor));
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
    // Keep the width until the renderer reports the bar's own size, so the row never clips.
    const rect = growFrom(from, side, { w: from.w, h: SIZES.bar.h }, workArea(s.anchor));
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

  // ---- people ----

  /** "Who is this": the people in the selection, resolved against the people layer. */
  async who(sessionId: number): Promise<WhoView> {
    const s = this.current(sessionId);
    const identity = this.settings.identity;
    if (!s?.selection) return { entries: [], identitySet: identity.name.trim().length > 0 };
    const container = (await s.container) ?? null;
    return whoFor(this.services.people, s.selection, container, identity, this.services.store.listKnownPeople());
  }

  // ---- Reply ----

  /** Three drafts to the selected message's author, streamed to `target` on reply:*. */
  async startReply(sessionId: number, target: WebContents): Promise<ReplyStart> {
    const requestId = randomUUID();
    const identity = this.settings.identity;
    const identitySet = identity.name.trim().length > 0;
    const send = <T>(channel: string, payload: T) => {
      if (!target.isDestroyed()) target.send(channel, payload);
    };
    const fail = (code: AskErrorEvent['code'], message: string) => send<AskErrorEvent>('reply:error', { requestId, code, message });
    const s = this.current(sessionId);
    if (!s?.selection) {
      setTimeout(() => fail('no_selection', 'Select a message first.'), 0);
      return { requestId, to: { name: null, personId: null, match: 'none', authorIsMe: false }, identitySet };
    }
    s.reply?.ctl.abort();
    const ctl = new AbortController();
    const state = { requestId, ctl, personId: null as string | null, done: false, used: false };
    s.reply = state;

    const container = (await s.container) ?? null;
    const people = this.services.people;
    const det = detectPeople(detectInputFor(s.selection, container), identity, this.services.store.listKnownPeople());
    const match = det.author ? resolvePerson(people, det.author, s.selection.source_app) : null;
    const person = match?.kind === 'exact' ? people.card(match.personId) : null;
    state.personId = person?.id ?? null;
    const a = det.author;
    const to: ReplyTo = {
      name: person?.name ?? a?.name ?? a?.email ?? (a?.handle ? `@${a.handle}` : null),
      personId: state.personId,
      match: match?.kind ?? 'none',
      authorIsMe: det.authorIsMe,
    };
    const input = { selection: s.selection, container, author: det.author, authorIsMe: det.authorIsMe, person, voice: people.voiceForPrompt(5) };

    void (async () => {
      const t = performance.now();
      let firstMs: number | null = null;
      try {
        const r = reply(this.services.llm, this.settings, input, ctl.signal);
        for await (const text of r.textStream) {
          firstMs ??= ms(t);
          send('reply:chunk', { requestId, text });
        }
        const model = await r.model;
        state.done = true;
        send('reply:done', { requestId, model });
        this.services.metrics.record('reply_drafts', { first_token_ms: firstMs ?? -1, total_ms: ms(t), person: Boolean(person) });
      } catch (e) {
        const code: AskErrorEvent['code'] = e instanceof LlmError ? e.code : ctl.signal.aborted ? 'aborted' : 'provider';
        const message = e instanceof LlmError ? e.message : 'The model call failed.';
        if (code !== 'aborted') this.services.metrics.record('reply_error', { code, ...(e instanceof LlmError && e.statusCode && { status: e.statusCode }) });
        fail(code, message);
      }
    })();
    return { requestId, to, identitySet };
  }

  cancelReply(requestId: string): void {
    const r = this.session?.reply;
    if (r?.requestId === requestId) r.ctl.abort();
  }

  /** Ctrl+C or Copy in the Reply panel. */
  replyCopied(sessionId: number): void {
    const s = this.current(sessionId);
    if (s?.reply) s.reply.used = true;
    this.services.metrics.record('reply_copied');
  }

  /**
   * Inserts a draft (spec: Inserting text): focus back to the source window, then paste. Reply
   * never sends. When focus can't be restored, or the focused field doesn't take text, the
   * draft goes on the clipboard instead and the panel says so. An inserted reply is stored as a
   * voice sample and, when the author is a known person, as an interaction with them.
   */
  async insertReply(sessionId: number, text: string, edited: boolean, personId?: string): Promise<ReplyInsertResult> {
    const s = this.current(sessionId);
    if (!s?.selection || !s.fg) throw new Error('This selection is gone. Select the message again.');
    const draft = text.trim();
    if (!draft) throw new Error('The draft is empty.');
    const people = this.services.people;
    const pid = personId && people.get(personId) ? personId : (s.reply?.personId ?? null);
    const sourceApp = s.selection.source_app;
    const record = (how: 'inserted' | 'copied') => {
      if (s.reply) s.reply.used = true;
      people.addVoice(draft, edited ? 'inserted_edited' : 'inserted');
      if (pid) people.addInteraction({ person_id: pid, direction: 'outbound', text: draft, source_app: sourceApp });
      this.services.metrics.record('reply_inserted', { how, edited, person: Boolean(pid), ms: ms(s.t0) });
    };
    const copy = (reason: 'focus' | 'not_editable' | 'paste'): ReplyInsertResult => {
      clipboard.writeText(draft);
      record('copied');
      log.info('reply copied', { reason });
      return { result: 'copied', reason };
    };
    const refocus = async () => {
      await this.helper.request('restore_focus', { handle: this.overlay.nativeHandle() }).catch(() => {});
      this.overlay.focus();
    };

    this.bouncing = true;
    try {
      try {
        await this.helper.request('restore_focus', { handle: s.fg.handle });
      } catch {
        await refocus();
        return copy('focus');
      }
      // Does the focused element take text? Unknown (no text provider found) still pastes.
      let editable: boolean | null = null;
      try {
        editable = (await this.helper.request('selection', { max_chars: 1 })).is_editable;
      } catch {
        editable = null;
      }
      if (editable === false) {
        await refocus();
        return copy('not_editable');
      }
      if (s.reply) s.reply.used = true;
      this.close('reply_inserted');
      try {
        await this.helper.request('paste', { text: draft });
      } catch {
        return copy('paste');
      }
      record('inserted');
      log.info('reply inserted', { edited, editable: editable ?? 'unknown' });
      return { result: 'inserted' };
    } finally {
      this.bouncing = false;
    }
  }

  /** What did I promise: one structured call for the commitments in the selected message. */
  async extractPromises(sessionId: number): Promise<PromisesResult> {
    const s = this.current(sessionId);
    if (!s?.selection) return { ok: false, code: 'no_selection', message: 'Nothing is selected.' };
    s.promisesCtl?.abort();
    const ctl = new AbortController();
    s.promisesCtl = ctl;
    const identity = this.settings.identity;
    const t = performance.now();
    try {
      const container = (await s.container) ?? null;
      const people = this.services.people;
      const det = detectPeople(detectInputFor(s.selection, container), identity, this.services.store.listKnownPeople());
      const authorMatch = det.author ? resolvePerson(people, det.author, s.selection.source_app) : null;
      s.author = { personId: authorMatch?.kind === 'exact' ? authorMatch.personId : null, isMe: det.authorIsMe };
      const rows = await extractPromises(this.services.llm, people, this.settings, { selection: s.selection, container, author: det.author, authorIsMe: det.authorIsMe }, ctl.signal);
      this.services.metrics.record('promises_extracted', { count: rows.length, ms: ms(t) });
      return {
        ok: true,
        rows,
        author: det.authorIsMe ? null : (det.author?.name ?? det.author?.email ?? null),
        authorIsMe: det.authorIsMe,
        identitySet: identity.name.trim().length > 0,
      };
    } catch (e) {
      const code: AskErrorEvent['code'] = e instanceof LlmError ? e.code : ctl.signal.aborted ? 'aborted' : 'provider';
      if (code !== 'aborted') this.services.metrics.record('promises_error', { code, ...(e instanceof LlmError && e.statusCode && { status: e.statusCode }) });
      if (!(e instanceof LlmError) && code !== 'aborted') log.error('promises failed', errorInfo(e));
      return { ok: false, code, message: e instanceof LlmError ? e.message : 'The model call failed.' };
    } finally {
      if (s.promisesCtl === ctl) s.promisesCtl = null;
    }
  }

  savePromises(sessionId: number, rows: PromiseSaveRow[]): { saved: number; created: number } {
    const s = this.current(sessionId);
    if (!s?.selection) throw new Error('This selection is gone. Select the message again.');
    const r = savePromises(this.services.people, rows, {
      message: s.selection.text,
      sourceApp: s.selection.source_app,
      authorPersonId: s.author?.personId ?? null,
      authorIsMe: s.author?.isMe ?? false,
    });
    this.services.metrics.record('promises_saved', { count: r.saved, created: r.created, offered: rows.length });
    log.info('promises saved', r);
    return r;
  }

  /** Person badges from tier 1 (local, a few ms): a known person with open commitments or a note. */
  private badgesFor(s: Session): OverlayState['badges'] {
    if (!s.selection) return [];
    try {
      const detection = detectPeople(detectInputFor(s.selection, null), this.settings.identity, this.services.store.listKnownPeople());
      return personBadges(this.services.people, detection, s.selection.source_app);
    } catch (e) {
      log.warn('person badges failed', errorInfo(e));
      return [];
    }
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
    void r.enriched.then((e) => log.info('save enriched', { embedded: e.embedded, entities: e.entities, skipped: e.entitiesSkipped ?? null, cancelled: e.cancelled }));
    return { itemId: r.item.id, collection: name, undoUntil: r.undoUntil };
  }

  // ---- closing ----

  close(reason: string): void {
    const s = this.session;
    const visible = this.overlay.isVisible;
    if (!s && !visible) return;
    const mode = this.state.mode;
    const focused = this.overlay.hasFocus;
    const trigger = s?.trigger ?? null;
    this.settleUntil = 0;
    if (!s) {
      this.overlay.update(HIDDEN_STATE);
      log.info('overlay closed', { reason, mode, focused });
      return;
    }
    this.endSession();
    this.overlay.update({ ...HIDDEN_STATE, sessionId: s.id });
    log.info('overlay closed', { reason, mode, focused, trigger });
    // Focus goes back to the source app, unless it already left (blur), the settings window is
    // taking it, or Reply already handed it back to paste.
    if (focused && s.fg && reason !== 'blur' && reason !== 'settings' && reason !== 'reply_inserted') {
      void this.helper.request('restore_focus', { handle: s.fg.handle }).catch(() => {});
    }
  }

  /** Ignores hide signals for a short time after the hotkey opens the bar. */
  private armHotkeySettle(): void {
    this.settleUntil = Date.now() + HOTKEY_SETTLE_MS;
  }

  private get hotkeySettling(): boolean {
    return Date.now() < this.settleUntil;
  }

  /**
   * Hides on an activity signal, except during the hotkey grace. A suppressed hide is logged
   * so the next vanish can be told apart from a real dismiss.
   */
  private activityHide(signal: HideSignal, ownForeground = false): void {
    const input = {
      signal,
      visible: this.overlay.isVisible,
      focused: this.overlay.hasFocus,
      osFocused: this.overlay.osFocused,
      ownForeground,
    };
    if (shouldHideOverlay({ ...input, settling: this.hotkeySettling })) {
      this.close(signal);
      return;
    }
    if (shouldHideOverlay({ ...input, settling: false })) log.info('overlay hide suppressed', { reason: signal });
  }

  private endSession(): void {
    const s = this.session;
    this.stopWatch();
    if (!s) return;
    s.routeCtl?.abort();
    s.promisesCtl?.abort();
    s.reply?.ctl.abort();
    if (s.reply?.done && !s.reply.used) this.services.metrics.record('reply_discarded');
    this.cancelAsks(s);
    this.session = null;
  }

  // ---- hide-on-activity watch (pill and unfocused bar) ----

  private startWatch(): void {
    this.stopWatch();
    void this.setInputWatch(true);
    this.watchTimer = setInterval(() => {
      if (!this.overlay.isVisible || this.overlay.hasFocus) return;
      const cursor = screen.getCursorScreenPoint();
      const hit = this.overlay.hitBounds();
      // The dot's window is click-through, so its hover is detected here rather than relying
      // on forwarded mouse events.
      if (this.state.mode === 'dot' && this.session && contains(hit, cursor)) {
        void this.expand(this.session.id);
        return;
      }
      if (distanceToRect(cursor, hit) > this.settings.capture.hideDistancePx) this.activityHide('mouse_away');
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
      placement: s.placement,
      obstacles: s.obstacles,
      pill: s.pill,
    };
  }

  /** Stores, per app or site, how soon after mouse-up its selection toolbar showed. */
  private learnToolbar(key: string, seenMs: number): void {
    const next = learnToolbarWait(this.settings.toolbarWaits, key, seenMs);
    if (!next) return;
    this.services.setSetting('toolbarWaits', next);
    log.info('toolbar wait learned', { ms: next[key], site: /^[-|]/.test(key) });
  }

  /** The one-time notice (e.g. a role's model went away), cleared once shown. */
  private takeNotice(): string | null {
    const n = this.settings.pendingNotice;
    if (n) this.services.setSetting('pendingNotice', null);
    return n;
  }
}
