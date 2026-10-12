import { randomUUID } from 'node:crypto';
import { app, clipboard, screen, type WebContents } from 'electron';
import {
  HelperError,
  LlmError,
  LlmStructuredDecision,
  Router,
  ask,
  classifyObstacles,
  cleanText,
  countWords,
  detectInputFor,
  detectPeople,
  extractPromises,
  resolvePerson,
  savePromises,
  personBadges,
  buildWho,
  buildWhoPrompt,
  readWho,
  authorFrom,
  authorUnknown,
  authorFirst,
  gateApp,
  gateAutoSelection,
  isoNow,
  learnKeyFor,
  foundAppToolbar,
  learnToolbarWait,
  mayCopyFallback,
  pillWait,
  reply,
  replyChannel,
  preferencesFor,
  REPLY_CHANNELS,
  preferenceLine,
  pickSignals,
  isMeaningfulEdit,
  WROTE_OWN,
  writeStyleNotes,
  STYLE_NOTES_EVERY,
  recall as recallFor,
  visualize,
  assignEmptySlots,
  pasteAsSaved,
  pasteList,
  composePaste as composeForHere,
  pasteSnippets,
  pasteTarget,
  recentSnippets,
  search as searchSaved,
  library as librarySaved,
  placeBar,
  placePill,
  pollForToolbar,
  placeNameFor,
  keyMatches,
  resolveAppMode,
  type ActionId,
  type TryItStep,
  type AppMode,
  type AskErrorEvent,
  type AskSaved,
  type ClassifiedObstacle,
  type CommandResult,
  type ContainerContext,
  type HelperEvent,
  type ObstacleDebug,
  type OverlayState,
  type PillTiming,
  type PromiseSaveRow,
  type EventSaveRow,
  type PromisesResult,
  type PasteCompose,
  type ReplyInsertResult,
  type ReplyPick,
  type ReplyRedo,
  type ModelRef,
  type ReplyStart,
  type ReplyTo,
  type RecallHit,
  type SearchResults,
  type LibraryQuery,
  type LibraryResult,
  type VisualizeResult,
  type Placement,
  type Point,
  type Rect,
  type RouteResult,
  type SaveDone,
  type SavedNotice,
  type SelectionPayload,
  type SelectionContext,
  type Trigger,
  type WhoRead,
  type DetectInput,
  type WhoView,
  type Item,
  type Surroundings,
} from '@glossly/core';
import type { HelperManager } from './helper-manager';
import { errorInfo, logger } from './log';
import { HIDDEN_STATE, MAX_W, SIZES, type Overlay } from './overlay';
import type { Services } from './services';
import { ExpiringLru, Lru, actionForSlot, replyCacheKey, contains, distanceToRect, emptySlotsView, growFrom, holdForRoute, isAvailable, mergeRoute, needsTier2, mouseAwayLimit, shouldHideOverlay, slotsView, type HideSignal } from './view';

const log = logger('capture');

const WATCH_INTERVAL_MS = 80;
/** After a click outside a focused bar, how long to let Windows move the foreground before checking it. */
const CLICK_SETTLE_MS = 120;
/** Who and Visualize results kept per input (see `whoCache`). */
const MODEL_CACHE_SIZE = 20;
const MAX_SELECTION_CHARS = 20_000;
/** Reply's drafts for a highlight are reused for this long; after that the conversation has likely moved on. */
const REPLY_CACHE_MS = 30 * 60_000;
/** Hotkey with nothing selected: how much text around the caret (or on screen) is read. */
const CARET_CHARS = 4000;
/**
 * After the hotkey opens the bar, ignore the key that opened it, a cursor that is still far
 * from the selection, and a focus or foreground bounce. The helper reports that key as
 * keyboard_activity about 50 to 100 ms later, often while the bar is visible and not focused yet.
 */
const HOTKEY_SETTLE_MS = 500;
/**
 * Keyboard activity hides the pill this long after it's reported, so the hotkey's first keys
 * (Ctrl, Alt) don't hide it before the hotkey arrives to expand it in place (decision 55).
 */
const KEY_HIDE_GRACE_MS = 400;

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
  /** The running Tasks extraction. */
  promisesCtl: AbortController | null;
  /** The running "Who is this" read. */
  whoCtl: AbortController | null;
  /** Who wrote the selected message, from the last extraction: their person id (exact match only) and whether it was the user. */
  author: { personId: string | null; isMe: boolean } | null;
  /** The latest Reply request: drafts done, and whether one was inserted or copied (else it counts as discarded). */
  /** `learned`: this session's pick has been recorded (Copy then Insert counts once). */
  reply: {
    requestId: string;
    ctl: AbortController;
    personId: string | null;
    done: boolean;
    used: boolean;
    learned: boolean;
    /** The highlight (`replyCacheKey`) and the text streamed so far, so a reopened panel picks up a run still going. */
    key: string;
    raw: string;
    start: ReplyStart | null;
  } | null;
  /** Recall cards for the selection, once found (null until then). */
  recall: RecallHit[] | null;
  /** Cards dismissed as "not related" in this session. */
  recallDismissed: Set<string>;
  /** "Ask about these": the saved items Ask uses instead of the top recall hits. */
  askRelated: string[] | null;
  /** Hotkey with nothing selected: whether the focused control takes text (null when unknown). */
  focusEditable: boolean | null;
  /** Hotkey with nothing selected: the text around the caret, or what is visible (helper context_caret). */
  surroundings: Surroundings | null;
  /** The running paste summary. */
  pasteCtl: AbortController | null;
  /** Saved without the Save panel (autosave or the save hotkey): Save becomes Undo. */
  saved: SavedNotice | null;
  /** Autosave moves its item to the route's collection once; set after that. */
  savedSettled: boolean;
  /** The running Visualize, and its last result (for Save). */
  visualCtl: AbortController | null;
  visual: Extract<VisualizeResult, { ok: true }> | null;
}

/** How long the auto path waits for the helper's mouse-down snapshot if it is still being taken. */
const BASELINE_WAIT_MS = 100;

/** Synthetic obstacles above and below the selection, for checking the dot by hand (dev builds only). */
const FORCE_DOT = !app.isPackaged && process.env.GLOSSLY_FORCE_DOT === '1';

/** Actions that work with nothing selected. */
const WITHOUT_SELECTION: readonly ActionId[] = ['ask', 'search', 'paste_list', 'paste_summary'];

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

function toPhysRect(r: Rect): Rect {
  const d = screen.dipToScreenRect(null, { x: r.x, y: r.y, width: r.w, height: r.h });
  return { x: d.x, y: d.y, w: d.width, h: d.height };
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

/** How long the slots wait for tier 2 after the route, when tier 1 couldn't say whose message it is (decision 51). */
const AUTHOR_WAIT_MS = 300;
/** Tier-2 text around the selection used to find its author: enough for a few messages back. */
const AUTHOR_BEFORE = 3000;

/** The selection with tier-2 text around it, for re-reading whose message it is. */
function withContainer(s: SelectionPayload, c: ContainerContext): SelectionContext {
  const start = Math.max(0, c.selection_start);
  const end = start + Math.max(0, c.selection_length);
  return { ...toContext(s), context_before: c.text.slice(Math.max(0, start - AUTHOR_BEFORE), start), context_after: c.text.slice(end, end + 500) };
}

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
  /** A keyboard-activity hide waiting out its grace (KEY_HIDE_GRACE_MS). */
  private keyHideTimer: ReturnType<typeof setTimeout> | null = null;
  private touchLogged = false;
  private inputWatch = false;
  /** Set while focus is handed to the source app to read tier 2 on the hotkey path. */
  private bouncing = false;
  /** The session whose pill or dot is expanding (tier 1 is being read). */
  private expanding: Session | null = null;
  /** The last autosave, so the same text in the same window isn't saved twice. */
  private lastAutosave: { handle: number; text: string; notice: SavedNotice } | null = null;
  /** Epoch ms until which a hotkey-opened bar stays up. 0 when not settling. */
  private settleUntil = 0;
  /**
   * Model results for the same input, so switching panels (or selecting the same text again)
   * doesn't spend another call. Keyed by the exact model input; failures are never kept.
   */
  private readonly whoCache = new Lru<string, WhoRead>(MODEL_CACHE_SIZE);
  /** A people read still running, so Who and Promises opened together share the one call. */
  private readonly whoPending = new Map<string, Promise<WhoRead>>();
  /** Finished Reply drafts per highlight (`replyCacheKey`), so switching panels doesn't write them again. */
  private readonly replyCache = new ExpiringLru<string, { raw: string; model: ModelRef }>(MODEL_CACHE_SIZE, REPLY_CACHE_MS);
  private readonly visualCache = new Lru<string, Extract<VisualizeResult, { ok: true }>>(MODEL_CACHE_SIZE);

  /**
   * `captureSource` returns the HWND of the one Glossly window that may be read (the setup's
   * "Try it" step), or null. Every other Glossly window, the overlay included, is ignored.
   */
  constructor(
    private readonly helper: HelperManager,
    private readonly overlay: Overlay,
    private readonly services: Services,
    private readonly captureSource: () => number | null = () => null,
    private readonly onTried: (step: TryItStep) => void = () => {},
  ) {
    helper.on('event', (ev) => this.onHelperEvent(ev));
    overlay.useSourceBounds(() => {
      const r = this.session?.fg?.rect;
      return r ? toDipRect(r) : null;
    });
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

  /** Tells setup's Try it step what happened, when the session reads from its window. */
  private tried(s: Session, step: TryItStep): void {
    const h = this.captureSource();
    if (h !== null && s.fg?.handle === h) this.onTried(step);
  }

  /** The "Don't show here" key; none for Glossly's own Try-it window. */
  private siteKey(fg: Foreground): string | null {
    return fg.handle === this.captureSource() ? null : placeNameFor({ process_name: fg.process_name, title: fg.title });
  }

  private current(id: number): Session | null {
    return this.session && this.session.id === id ? this.session : null;
  }

  /** The helper's selection, with what other apps leave in copied text (OBJ, invisible characters) cleaned out. */
  private async readSelection(): Promise<CommandResult<'selection'>> {
    const sel = await this.helper.request('selection', { max_chars: MAX_SELECTION_CHARS });
    return { ...sel, text: cleanText(sel.text) };
  }

  /**
   * Whether Windows really has the overlay in front. Electron's isFocused() can say yes after
   * the hotkey's focus request was refused, and then no blur ever comes. Null when the helper
   * can't tell.
   */
  private async overlayInFront(): Promise<boolean | null> {
    try {
      return (await this.helper.request('foreground')).handle === this.overlay.nativeHandle();
    } catch {
      return null;
    }
  }

  // ---- helper events ----

  private onHelperEvent(ev: HelperEvent): void {
    switch (ev.event) {
      case 'mouse_down': {
        this.autoGen++;
        if (!this.overlay.isVisible || contains(this.overlay.hitBounds(), toDipPoint(ev))) return;
        if (!this.overlay.hasFocus) {
          this.close('click_outside');
          return;
        }
        // A focused bar closes on blur. If Windows never put it in front, no blur comes and the
        // bar would stay up, so once the click has landed, check what is really in front.
        const id = this.session?.id;
        setTimeout(() => void this.closeIfNotInFront(id), CLICK_SETTLE_MS);
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
        this.activityHide(ev.event);
        return;
      case 'keyboard_activity':
        // Ctrl, Alt, or Windows held: the start of a shortcut, maybe the hotkey, so the pill stays
        // until they're let go (decision 58). Otherwise the hotkey cancels this if it comes within
        // the grace, and expands the pill in place.
        if (ev.modifiers) return;
        this.keyHideTimer ??= setTimeout(() => {
          this.keyHideTimer = null;
          this.activityHide('keyboard_activity');
        }, KEY_HIDE_GRACE_MS);
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
      const sel = await this.readSelection();
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
        lastLine: sel.last_line ? toDipRect(sel.last_line) : null,
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
        whoCtl: null,
        author: null,
        reply: null,
        recall: null,
        recallDismissed: new Set(),
        askRelated: null,
        focusEditable: null,
        surroundings: null,
        pasteCtl: null,
        saved: null,
        savedSettled: false,
        visualCtl: null,
        visual: null,
      };
      this.session = session;
      if (settings.saveMode === 'autosave' && session.siteKey !== null) this.autosave(session);
      this.overlay.update(
        {
          ...HIDDEN_STATE,
          sessionId: session.id,
          saved: session.saved,
          mode: placement.mode,
          placement,
          hasSelection: true,
          wordCount: countWords(sel.text),
          siteKey: session.siteKey,
          hiddenHere: this.hiddenHere(session),
          debug: this.debugFor(session),
        },
        placement.rect,
      );
      this.tried(session, 'pill');
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
    this.cancelKeyHide();
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
    let focusEditable: boolean | null = null;
    let surroundings: Surroundings | null = null;

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
            sel = await this.readSelection();
            password = sel.is_password;
          } catch (e) {
            if (e instanceof HelperError && e.code === 'password_field') password = true;
            else if (e instanceof HelperError && (e.code === 'closed' || e.code === 'timeout')) throw e;
          }
          timings.selection = ms(t);
          focusEditable = sel ? sel.is_editable : null;
          let text = sel?.text ?? '';
          let method: SelectionPayload['method'] = sel?.method ?? 'uia';
          if (sel?.bounds && text.trim()) physBounds = sel.bounds;

          if (password) notice = 'This is a password field. Nothing was read.';
          else if (mayCopyFallback(sel, appId, settings)) {
            t = performance.now();
            const cf = await this.helper.request('copy_fallback', { timeout_ms: settings.capture.copyTimeoutMs });
            timings.copy_fallback = ms(t);
            text = cleanText(cf.text);
            method = 'copy';
          }

          if (!text.trim() && !password) {
            // Nothing selected: read what is around the caret, or on screen, before the bar takes focus.
            t = performance.now();
            try {
              const c = await this.helper.request('context_caret', { max_chars: CARET_CHARS });
              timings.context_caret = ms(t);
              focusEditable ??= c.is_editable;
              const around = cleanText(c.text, { trimEdges: false });
              if (c.source !== 'none' && around.trim()) surroundings = { text: around, caret: c.caret >= 0 ? Math.min(c.caret, around.length) : -1, source: c.source };
            } catch (e) {
              if (e instanceof HelperError && (e.code === 'closed' || e.code === 'timeout')) throw e;
              /* a password field or nothing readable: no surroundings */
            }
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
      whoCtl: null,
      author: null,
      reply: null,
      recall: null,
      recallDismissed: new Set(),
      askRelated: null,
      focusEditable,
      surroundings,
      pasteCtl: null,
      saved: null,
      savedSettled: false,
      visualCtl: null,
      visual: null,
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
    const common = {
      ...HIDDEN_STATE,
      sessionId: session.id,
      keyboard: true,
      hasSelection: Boolean(selection),
      wordCount: selection ? countWords(selection.text) : 0,
      siteKey: session.siteKey,
      hiddenHere: this.hiddenHere(session),
      debug: this.debugFor(session),
      badges: this.badgesFor(session),
      notice: notice ?? this.takeNotice(),
      // Nothing selected and the cursor is in a text field: a search result types into it.
      canInsert: !selection && focusEditable === true,
    };
    if (selection) {
      this.overlay.update({ ...common, mode: 'bar', placement, slots: this.initialSlots(quick) }, placement.rect);
    } else {
      // Nothing selected: the search box opens at once, under Ask and Search.
      const rect = growFrom(placement.rect, placement.side, SIZES.panel, workArea(session.anchor));
      this.overlay.update(
        { ...common, mode: 'panel', panel: 'search', placement: { mode: 'pill', side: placement.side, rect }, slots: emptySlotsView(this.emptySlots(session)) },
        rect,
      );
    }
    this.services.metrics.record('bar_shown', { trigger: 'hotkey', ms: timings.total, has_selection: Boolean(selection) });
    if (selection) this.tried(session, 'bar');
    if (selection) {
      void this.routeModel(session);
      void this.runRecall(session);
    }
  }

  /**
   * Focuses the overlay. Windows may refuse the foreground change (for example while the
   * source app is in its Alt menu mode); then the helper forces it with restore_focus.
   * `settle` restarts the hotkey grace so a blur before that focus lands does not hide the bar.
   */
  private focusOverlay(settle = false): void {
    if (settle) this.armHotkeySettle();
    this.overlay.focus();
    setTimeout(async () => {
      if (!this.overlay.hasFocus || this.bouncing) return;
      // Asks Windows, not Electron: isFocused() can be true while another window is in front.
      if ((await this.overlayInFront()) !== false || !this.overlay.hasFocus || this.bouncing) return;
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

  /** Pill to bar. Ask and Save paint at once. Slots 3 and 4 wait for the model when one will be called. */
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
        slots: this.initialSlots(quick),
        badges: this.badgesFor(s),
        debug: this.debugFor(s),
        notice: this.takeNotice(),
        // Hotkey hints are on for the whole focused bar, from the first paint.
        ...(viaHotkey && { keyboard: true }),
      },
      rect,
    );
    this.services.metrics.record('bar_shown', { trigger: viaHotkey ? 'hotkey' : 'auto', ms: ms(s.t0) });
    this.tried(s, 'bar');
    void this.routeModel(s);
    void this.runRecall(s);
  }

  private async readTier1(s: Session): Promise<void> {
    if (s.tier1Read || !s.selection) return;
    s.tier1Read = true;
    const n = this.settings.capture.contextChars;
    const t = performance.now();
    try {
      const ctx = await this.helper.request('context', { before: n, after: n });
      s.selection.context_before = cleanText(ctx.before, { trimEdges: false });
      s.selection.context_after = cleanText(ctx.after, { trimEdges: false });
    } catch {
      /* no tier 1 (copy fallback, or the app lost its selection): route on the selection alone */
    }
    s.timings.context = ms(t);
  }

  /** Slots for the bar with nothing selected, under the same rule as the contextual actions. */
  private emptySlots(s: Session) {
    const settings = this.settings;
    return assignEmptySlots(
      {
        editable: s.focusEditable,
        recent: recentSnippets(this.services.store, settings).length,
        summaryModel: this.services.llm.hasModel('chat'),
        writing: s.surroundings?.source === 'caret' && s.surroundings.text.trim().length > 0 && this.services.store.collectionCounts().total > 0,
      },
      settings.router,
    );
  }

  /** True when Router.route will spend a model call. Rules then wait instead of flashing. */
  private routeWillCallModel(): boolean {
    return this.settings.privacy !== 'local' && this.services.llm.hasModel('decision');
  }

  private initialSlots(quick: RouteResult | null): ReturnType<typeof slotsView> | null {
    if (!quick) return null;
    const view = slotsView(quick, 'rules');
    return this.routeWillCallModel() ? holdForRoute(view) : view;
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
    // A chat message with no header around it in tier 1 may be the user's own: read tier 2 while
    // the router runs (it's read on the first click anyway) and score again with it before slots
    // 3 and 4 show (decision 51). Not on the hotkey path, where the read would move focus.
    const tier2 =
      s.route && authorUnknown(s.route.features) && !this.overlay.hasFocus && s.selection.method !== 'copy'
        ? this.readTier2(s).then(() => s.container)
        : null;
    try {
      const router = this.router();
      let r = await router.route(toContext(s.selection), ctl.signal);
      if (!this.current(s.id) || ctl.signal.aborted) return;
      let author: 'tier1' | 'tier2' | 'unknown' = 'tier1';
      if (tier2) {
        const c = await Promise.race([tier2, new Promise<null>((res) => setTimeout(() => res(null), AUTHOR_WAIT_MS))]);
        if (!this.current(s.id) || ctl.signal.aborted) return;
        if (c?.source === 'container' && c.text && s.selection) {
          r = router.rescore(r, withContainer(s.selection, c));
          author = r.features.speakerFound ? 'tier2' : 'unknown';
        } else author = 'unknown';
      }
      s.route = r;
      s.timings.route = Math.round(r.ms);
      const prev = this.state.slots;
      const next = slotsView(r, r.fallback ? 'rules_fallback' : 'model');
      const saveOpen = this.state.mode === 'panel' && this.state.panel === 'save';
      const slots = prev ? mergeRoute(prev, next, { keepSave: saveOpen }) : next;
      this.overlay.patch({ slots, debug: this.debugFor(s), saved: this.settleAutosave(s, slots.slot2.collection) });
      const routed = {
        provider: r.decisions.provider,
        fallback: r.fallback ?? 'none',
        ms: Math.round(r.ms),
        budget_ms: this.settings.router.decisionTimeoutMs,
        author,
        mine: r.features.authorIsMe,
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
    if (!s.selection && !WITHOUT_SELECTION.includes(action)) return;
    if (action === 'save' && s.saved) {
      this.undoSaved(sessionId);
      return;
    }
    this.stopWatch();
    this.services.metrics.record('action_clicked', { action, ms: ms(s.t0), trigger: s.trigger });
    this.tried(s, 'action');
    if (action === 'recall') this.services.metrics.record('recall_opened', { count: this.visibleRecall(s).length });

    if (needsTier2(action) && s.selection) await this.readTier2(s);
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

  /**
   * "Show here", the menu item's other side when this app is hotkey-only: removes the user's
   * rules that make it so (including older title keys like "Discord |"), and when a built-in
   * default still does (Excel, terminals), stores an explicit "auto" for it.
   */
  showHere(sessionId: number): { key: string; mode: AppMode } | null {
    const s = this.current(sessionId);
    if (!s?.siteKey || !s.fg) return null;
    const app = { process_name: s.fg.process_name, title: s.fg.title };
    const modes = { ...this.settings.appModes };
    for (const key of Object.keys(modes)) if (modes[key] === 'hotkey' && keyMatches(key, app)) delete modes[key];
    if (resolveAppMode(app, { ...this.settings, appModes: modes }).mode === 'hotkey') modes[s.siteKey] = 'auto';
    this.services.setSetting('appModes', modes);
    this.close('show_here');
    log.info('app set to show the pill');
    return { key: s.siteKey, mode: 'auto' };
  }

  /** This app or site shows the bar only on the hotkey, so the menu offers "Show here". */
  private hiddenHere(s: Session): boolean {
    if (!s.siteKey || !s.fg) return false;
    return resolveAppMode({ process_name: s.fg.process_name, title: s.fg.title }, this.settings).mode === 'hotkey';
  }

  // ---- people ----

  /** "Who is this": one model read when one is available, then code keeps or drops each row. */
  async who(sessionId: number): Promise<WhoView> {
    const s = this.current(sessionId);
    const identity = this.settings.identity;
    const empty: WhoView = { entries: [], identitySet: identity.name.trim().length > 0, local: null };
    if (!s?.selection) return empty;
    s.whoCtl?.abort();
    const ctl = new AbortController();
    s.whoCtl = ctl;
    const t = performance.now();
    try {
      const input = detectInputFor(s.selection, (await s.container) ?? null);
      const { read, cached } = await this.readPeople(input, ctl.signal);
      // Matched against saved people every time, so someone added since shows as known.
      const view = buildWho(this.services.people, { people: read.people, author: null, authorIsMe: false }, s.selection.source_app, empty.identitySet, read.local);
      log.info('who looked up', { count: view.entries.length, source: view.local ?? 'model', messages: read.messages?.length ?? 0, cached, ms: ms(t) });
      return view;
    } catch (e) {
      const code = e instanceof LlmError ? e.code : ctl.signal.aborted ? 'aborted' : 'provider';
      if (code !== 'aborted') log.error('who failed', { code });
      throw e;
    } finally {
      if (s.whoCtl === ctl) s.whoCtl = null;
    }
  }

  /**
   * The conversation read (decision 48): who wrote each message and who the text names, cached per
   * text, so Who is this, Tasks, and Reply share one call per selection. The key is the read's
   * prompt, so every caller builds the input with `detectInputFor` and the same container. A
   * text-only pass (Local only, no key, a failed call) isn't kept.
   */
  private async readPeople(input: DetectInput, signal: AbortSignal): Promise<{ read: WhoRead; cached: boolean }> {
    const key = buildWhoPrompt(this.settings.identity, input);
    const hit = this.whoCache.get(key);
    if (hit) return { read: hit, cached: true };
    const pending = this.whoPending.get(key);
    if (pending) return { read: await pending, cached: true };
    const run = readWho(this.services.llm, this.settings, input, signal, (e) =>
      log.warn('who model failed, reading the text only', { code: e instanceof LlmError ? e.code : 'provider' }),
    );
    this.whoPending.set(key, run);
    try {
      const read = await run;
      if (read.local === null) this.whoCache.set(key, read);
      return { read, cached: false };
    } finally {
      this.whoPending.delete(key);
    }
  }

  /** Delete all data: forget the cached model reads of captured text too. */
  clearCaches(): void {
    this.whoCache.clear();
    this.replyCache.clear();
    this.visualCache.clear();
  }

  // ---- Reply ----

  /** Three drafts to the selected message's author, streamed to `target` on reply:*. */
  async startReply(sessionId: number, target: WebContents, redo?: ReplyRedo): Promise<ReplyStart> {
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
      return { requestId, to: { name: null, email: null, handle: null, personId: null, match: 'none', authorIsMe: false }, identitySet, channel: 'other' };
    }
    const container = (await s.container) ?? null;
    const people = this.services.people;
    const readInput = detectInputFor(s.selection, container);
    const det = detectPeople(readInput, identity, this.services.store.listKnownPeople());
    // The conversation read (decision 48): who wrote what, shared with Who and Tasks (often cached
    // by now). The panel says "Reading the conversation…" until this answers. A failed read leaves the parser's.
    const tRead = performance.now();
    const got = await this.readPeople(readInput, new AbortController().signal).catch(() => null);
    const read = got?.read ?? null;
    const by = authorFrom(read, det);
    const a = by.author;
    const author = by.authorIsMe ? 'me' : (a?.email ?? (a?.handle ? `@${a.handle}` : null) ?? a?.name ?? null);
    const key = replyCacheKey({ place: s.siteKey ?? s.selection.source_app, author, text: s.selection.text });
    // The panel was closed and opened again while the drafts were still being written: carry on
    // with that run. The text so far comes back with this answer; the rest streams under the same id.
    const running = s.reply;
    if (!redo && running && !running.done && running.start && running.key === key && !running.ctl.signal.aborted) {
      log.info('reply drafts', { resumed: true });
      return { ...running.start, resumed: running.raw };
    }
    s.reply?.ctl.abort();
    const ctl = new AbortController();
    const state: NonNullable<Session['reply']> = { requestId, ctl, personId: null, done: false, used: false, learned: false, key, raw: '', start: null };
    s.reply = state;

    const match = a ? resolvePerson(people, a, s.selection.source_app) : null;
    const person = match?.kind === 'exact' ? people.card(match.personId) : null;
    state.personId = person?.id ?? null;
    const to: ReplyTo = {
      name: person?.name ?? a?.name ?? a?.email ?? (a?.handle ? `@${a.handle}` : null),
      email: a?.email ?? null,
      handle: a?.handle ?? null,
      personId: state.personId,
      match: match?.kind ?? 'none',
      authorIsMe: by.authorIsMe,
    };
    // Samples, preferences, and notes for this person, their relationship, and this kind of platform (Profile > How you write).
    const channel = replyChannel(s.selection.source_app, s.selection.window_title);
    const audience = { channel, personId: state.personId, relationship: person?.relationship ?? null };
    const learning = this.settings.replyLearning;
    const preferences = learning
      ? preferencesFor(people.styleSignals(), audience).map((p) => preferenceLine(p, p.scope === 'person' ? person?.name : null))
      : [];
    const input = {
      selection: s.selection,
      container,
      author: a,
      authorIsMe: by.authorIsMe,
      person,
      voice: people.voiceForPrompt(3, audience),
      preferences,
      notes: learning ? people.styleNotes(channel).map((n) => n.text) : [],
      redo: redo ?? null,
      messages: read?.messages ?? null,
      channel,
    };
    if (redo) {
      // "Shorter" or "Longer" on all three drafts says which way they were wrong; the other asks only steer this run.
      const length = redo.asks.includes('shorter') ? 'shorter' : redo.asks.includes('longer') ? 'longer' : null;
      if (learning && length) people.addStyleSignals([{ dimension: 'length', pole: length, weight: 1 }], { channel, personId: state.personId });
      this.services.metrics.record('reply_redo', { asks: redo.asks.join(','), typed: Boolean(redo.note?.trim()) });
    }

    // The same highlight gets the drafts it already has: switching panels and back, or selecting
    // it again, shows them without another call. "None of these" always writes new ones, and
    // those become the cached drafts.
    const start: ReplyStart = { requestId, to, identitySet, channel };
    state.start = start;
    const hit = redo ? undefined : this.replyCache.get(key);
    if (hit) {
      setTimeout(() => {
        if (s.reply !== state) return;
        state.done = true;
        send('reply:chunk', { requestId, text: hit.raw });
        send('reply:done', { requestId, model: hit.model });
        log.info('reply drafts', { cached: true });
      }, 0);
      return start;
    }

    log.info('reply drafts', { cached: false, redo: Boolean(redo), author: Boolean(author), read: read ? (read.local ?? 'model') : 'failed', read_cached: got?.cached ?? false, messages: read?.messages?.length ?? 0, read_ms: ms(tRead) });
    void (async () => {
      const t = performance.now();
      let firstMs: number | null = null;
      let raw = '';
      try {
        const r = reply(this.services.llm, this.settings, input, ctl.signal);
        for await (const text of r.textStream) {
          firstMs ??= ms(t);
          raw += text;
          state.raw = raw;
          send('reply:chunk', { requestId, text });
        }
        const model = await r.model;
        state.done = true;
        if (raw.trim()) this.replyCache.set(key, { raw, model });
        send('reply:done', { requestId, model });
        this.services.metrics.record('reply_drafts', { first_token_ms: firstMs ?? -1, total_ms: ms(t), person: Boolean(person) });
      } catch (e) {
        const code: AskErrorEvent['code'] = e instanceof LlmError ? e.code : ctl.signal.aborted ? 'aborted' : 'provider';
        const message = e instanceof LlmError ? e.message : 'The model call failed.';
        if (code !== 'aborted') this.services.metrics.record('reply_error', { code, ...(e instanceof LlmError && e.statusCode && { status: e.statusCode }) });
        fail(code, message);
      }
    })();
    return start;
  }

  cancelReply(requestId: string): void {
    const r = this.session?.reply;
    if (r?.requestId === requestId) r.ctl.abort();
  }

  /** Ctrl+C or Copy in the Reply panel. A copy is a pick too: it is learned from like an insert. */
  replyCopied(sessionId: number, text?: string, pick?: ReplyPick, personId?: string): void {
    const s = this.current(sessionId);
    if (s?.reply) s.reply.used = true;
    this.services.metrics.record('reply_copied');
    if (s && text?.trim() && pick) {
      const pid = personId && this.services.people.get(personId) ? personId : (s.reply?.personId ?? null);
      this.learnFromReply(s, text.trim(), pid, pick);
    }
  }

  /**
   * What a picked draft teaches (Profile > How you write). An edit worth the name becomes a voice
   * sample, with where it was written and the draft it came from; an unedited draft is the
   * model's writing, so it isn't one. The pick itself is stored only as which way it leaned.
   * Every few edits, the style notes are written again.
   */
  private learnFromReply(s: Session, final: string, personId: string | null, pick: ReplyPick): void {
    const r = s.reply;
    if (!r || r.learned || !s.selection || !this.settings.replyLearning) return;
    r.learned = true;
    const people = this.services.people;
    const channel = replyChannel(s.selection.source_app, s.selection.window_title);
    const own = pick.chosen === WROTE_OWN;
    const original = own ? undefined : pick.drafts[pick.chosen]?.text;
    if (!own && original === undefined) return;
    const edited = own || isMeaningfulEdit(original!, final);
    // A reply the user wrote is all theirs: a voice sample, but no draft to compare for the style notes.
    if (own) people.addVoice(final, 'written', { channel, personId });
    else if (edited) {
      people.addVoice(final, 'inserted_edited', { channel, personId, original });
      this.countStyleEdit();
    }
    const signals = pickSignals({ drafts: pick.drafts, chosen: pick.chosen, final });
    people.addStyleSignals(signals, { channel, personId });
    log.info('reply learned', { signals: signals.length, channel, edited, own, person: Boolean(personId) });
  }

  private styleNotesRunning = false;

  /** Counts an edited reply; every STYLE_NOTES_EVERY of them, the notes are written again in the background. */
  private countStyleEdit(): void {
    const store = this.services.store;
    const pending = Number(store.getMeta('style_edits_pending') ?? 0) + 1;
    if (pending < STYLE_NOTES_EVERY || this.styleNotesRunning) {
      store.setMeta('style_edits_pending', String(pending));
      return;
    }
    store.setMeta('style_edits_pending', '0');
    this.styleNotesRunning = true;
    const people = this.services.people;
    // What the picks show per kind of platform, as the Reply prompt words it (decision 49).
    const signals = people.styleSignals();
    const picks = Object.fromEntries(
      REPLY_CHANNELS.map((channel) => [
        channel,
        preferencesFor(signals, { channel, personId: null, relationship: null })
          .filter((p) => p.scope === 'channel')
          .map((p) => preferenceLine(p)),
      ]),
    );
    const current = people.styleNotes().map((n) => ({ text: n.text, channel: n.channel }));
    void writeStyleNotes(this.services.llm, { pairs: people.editedPairs(), current, picks, removed: people.removedStyleNotes() })
      .then((r) => {
        // The model may see nothing new: the notes there are stay.
        if (!r.keep) people.replaceStyleNotes(r.notes);
        log.info('style notes written', { kept: r.keep, count: r.keep ? current.length : r.notes.length });
      })
      .catch((e: unknown) => {
        // Local only, no key, or a failed call: try again after the next edit.
        store.setMeta('style_edits_pending', String(STYLE_NOTES_EVERY - 1));
        log.warn('style notes skipped', { code: e instanceof LlmError ? e.code : 'provider' });
      })
      .finally(() => {
        this.styleNotesRunning = false;
      });
  }

  /**
   * Inserts a draft (spec: Inserting text). Reply never sends. An inserted reply is stored as a
   * voice sample and, when the author is a known person, as an interaction with them.
   */
  async insertReply(sessionId: number, text: string, edited: boolean, personId?: string, pick?: ReplyPick): Promise<ReplyInsertResult> {
    const s = this.current(sessionId);
    if (!s?.selection || !s.fg) throw new Error('This selection is gone. Select the message again.');
    const draft = text.trim();
    if (!draft) throw new Error('The draft is empty.');
    const people = this.services.people;
    const pid = personId && people.get(personId) ? personId : (s.reply?.personId ?? null);
    const sourceApp = s.selection.source_app;
    const record = (how: 'inserted' | 'copied') => {
      if (s.reply) s.reply.used = true;
      if (pick) this.learnFromReply(s, draft, pid, pick);
      if (pid) people.addInteraction({ person_id: pid, direction: 'outbound', text: draft, source_app: sourceApp });
      this.services.metrics.record('reply_inserted', { how, edited, own: pick?.chosen === WROTE_OWN, person: Boolean(pid), ms: ms(s.t0) });
    };
    // The selected message is usually read-only, so the reply goes into the page's reply box.
    return this.insertText(s, draft, 'reply', record, { findField: true });
  }

  /**
   * The insert path (spec: Inserting text): focus back to the source window, then paste. When
   * focus can't be restored, or no field takes text, the text goes on the clipboard instead
   * and the panel says so. `record` runs once the text is placed either way. With `findField`,
   * a read-only focus (the selected message) hands over to the nearest text field below the
   * selection, such as a chat composer or a reply box, even though it isn't focused.
   */
  private async insertText(
    s: Session,
    text: string,
    what: 'reply' | 'paste' | 'search',
    record: (how: 'inserted' | 'copied') => void,
    opts: { findField?: boolean } = {},
  ): Promise<ReplyInsertResult> {
    if (!s.fg) throw new Error('The window this came from is gone.');
    const copy = (reason: 'focus' | 'not_editable' | 'paste'): ReplyInsertResult => {
      clipboard.writeText(text);
      record('copied');
      log.info(`${what} copied`, { reason });
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
      let field: 'focused' | 'found' | 'unknown' = editable === null ? 'unknown' : 'focused';
      if (editable === false && opts.findField && s.selection) {
        const t = performance.now();
        const found = await this.helper.request('focus_field', { near: toPhysRect(s.bounds) }).catch(() => null);
        log.info('field search', { found: found?.found ?? false, type: found?.control_type ?? 'error', ms: ms(t) });
        if (found?.found) {
          editable = true;
          field = 'found';
        }
      }
      if (editable === false) {
        await refocus();
        return copy('not_editable');
      }
      this.close(`${what}_inserted`);
      try {
        await this.helper.request('paste', { text });
      } catch {
        return copy('paste');
      }
      record('inserted');
      log.info(`${what} inserted`, { field });
      return { result: 'inserted' };
    } finally {
      this.bouncing = false;
    }
  }

  // ---- Visualize ----

  async runVisualize(sessionId: number): Promise<VisualizeResult> {
    const s = this.current(sessionId);
    if (!s?.selection) return { ok: false, code: 'no_selection', message: 'Nothing is selected.' };
    s.visualCtl?.abort();
    const ctl = new AbortController();
    s.visualCtl = ctl;
    const t = performance.now();
    // Without a model (Local only with no local model, or no key) code draws a plain chart, so it is a different answer for the same text.
    const key = `${this.services.llm.hasModel('fast') ? 'model' : 'code'}
${s.selection.text}`;
    const hit = this.visualCache.get(key);
    if (hit) {
      s.visual = hit;
      log.info('visualized', { ok: true, cached: true, ms: ms(t) });
      return hit;
    }
    try {
      const r = await visualize({ llm: this.services.llm, settings: () => this.settings }, s.selection.text, ctl.signal);
      if (r.ok) {
        this.visualCache.set(key, r);
        s.visual = r;
        this.services.metrics.record('visualize_done', { source: r.table.source, rows: r.table.rows.length, chart: r.chartBy ?? 'table', ms: ms(t) });
      } else if (r.code !== 'aborted') this.services.metrics.record('visualize_error', { code: r.code });
      log.info('visualized', { ok: r.ok, ...(r.ok ? { source: r.table.source, chart: r.chartBy ?? 'table', ...(r.rejected && { rejected: r.rejected }) } : { code: r.code }), ms: ms(t) });
      return r;
    } finally {
      if (s.visualCtl === ctl) s.visualCtl = null;
    }
  }

  saveVisualize(sessionId: number): SaveDone {
    const s = this.current(sessionId);
    if (!s?.selection || !s.visual) throw new Error('Nothing to save yet.');
    const collection = s.route?.decisions.best_collection ?? 'Notes';
    const v = s.visual;
    const r = this.services.save.saveChart({ csv: v.csv, data: { columns: v.table.columns, rows: v.table.rows, types: v.types, spec: v.spec }, collection, selection: s.selection });
    void r.enriched.then((e) => log.info('save enriched', { embedded: e.embedded, entities: e.entities, skipped: e.entitiesSkipped ?? null, cancelled: e.cancelled }));
    return { itemId: r.item.id, collection, undoUntil: r.undoUntil };
  }

  // ---- Paste (nothing selected) ----

  /**
   * The snippets that fit where the cursor is (by meaning against the surroundings, else the
   * newest), as a list shaped for the spot, or written for it by the Chat model. Shown before
   * anything is pasted.
   */
  async composePaste(sessionId: number, kind: 'list' | 'summary'): Promise<PasteCompose> {
    const s = this.current(sessionId);
    if (!s) return { ok: false, code: 'no_selection', message: 'This bar is gone. Press the hotkey again.' };
    const target = pasteTarget(s.fg?.process_name ?? '', s.fg?.title ?? '');
    const t = performance.now();
    const sv = this.services;
    const picked = await pasteSnippets({ store: sv.store, embedder: () => sv.embed.embedder(), settings: () => sv.settings }, { surroundings: s.surroundings, target });
    const items = picked.items;
    if (items.length === 0) return { ok: false, code: 'no_selection', message: `Nothing saved in the last ${this.settings.paste.recentDays} days.` };
    const base = { count: items.length, total: items.length, target, reason: picked.reason };
    if (kind === 'list') {
      this.services.metrics.record('paste_composed', { kind, count: items.length, target, reason: picked.reason, ms: ms(t) });
      return { ok: true, ...base, text: pasteList(items, target), asSaved: pasteAsSaved(items) };
    }
    s.pasteCtl?.abort();
    const ctl = new AbortController();
    s.pasteCtl = ctl;
    try {
      const draft = await composeForHere(
        this.services.llm,
        { items, target, app: s.fg?.process_name ?? '', title: s.fg?.title ?? '', surroundings: s.surroundings },
        ctl.signal,
      );
      this.services.metrics.record('paste_composed', { kind, count: draft.used.length, offered: items.length, target, reason: picked.reason, format: draft.format, ms: ms(t) });
      if (!draft.text) return { ok: false, code: 'no_selection', message: 'None of your saved snippets fit what you are writing. Paste snippets lists them anyway.' };
      return { ok: true, ...base, count: draft.used.length || items.length, text: draft.text, format: draft.format };
    } catch (e) {
      const code: AskErrorEvent['code'] = e instanceof LlmError ? e.code : ctl.signal.aborted ? 'aborted' : 'provider';
      if (code !== 'aborted') this.services.metrics.record('paste_error', { code, ...(e instanceof LlmError && e.statusCode && { status: e.statusCode }) });
      return { ok: false, code, message: e instanceof LlmError ? e.message : 'The model call failed.' };
    } finally {
      if (s.pasteCtl === ctl) s.pasteCtl = null;
    }
  }

  /**
   * A search result picked with something to type into (the hotkey opened over a text field):
   * the item's text is pasted there. Without one, the panel copies instead and never calls this.
   */
  async insertItem(sessionId: number, itemId: string): Promise<ReplyInsertResult> {
    const s = this.current(sessionId);
    if (!s) throw new Error('This bar is gone. Press the hotkey again.');
    const item = this.services.store.getItem(itemId);
    if (!item) throw new Error('That item no longer exists.');
    return this.insertText(s, cleanText(item.text), 'search', (how) => this.services.metrics.record('search_inserted', { how, ms: ms(s.t0) }));
  }

  async insertPaste(sessionId: number, text: string, kind: 'list' | 'summary', edited: boolean): Promise<ReplyInsertResult> {
    const s = this.current(sessionId);
    if (!s) throw new Error('This bar is gone. Press the hotkey again.');
    const body = text.trim();
    if (!body) throw new Error('There is nothing to paste.');
    return this.insertText(s, body, 'paste', (how) => this.services.metrics.record('paste_inserted', { kind, how, edited, ms: ms(s.t0) }));
  }

  /** Tasks: one structured call for the tasks in the selected message, or patterns without a model. */
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
      const input = detectInputFor(s.selection, container);
      const det = detectPeople(input, identity, this.services.store.listKnownPeople());
      // The conversation read comes first (or from Who's cache): it says who wrote each message,
      // so You owe and They owe follow the real authors, and a new person gets the same email,
      // note, and relationship Who is this would give them. A failed read leaves the parser's author.
      const read = await this.readPeople(input, ctl.signal).then(
        (r) => r.read,
        () => null,
      );
      if (ctl.signal.aborted) throw new LlmError('aborted', 'Cancelled');
      const { author, authorIsMe } = authorFrom(read, det);
      const authorMatch = author ? resolvePerson(people, author, s.selection.source_app) : null;
      s.author = { personId: authorMatch?.kind === 'exact' ? authorMatch.personId : null, isMe: authorIsMe };
      const { rows, open, events, sameDay, byRules } = await extractPromises(
        this.services.llm,
        people,
        this.settings,
        { selection: s.selection, container, author, authorIsMe, people: authorFirst(det.people, author), messages: read?.messages ?? null },
        ctl.signal,
        new Date(),
        read?.people ?? [],
        this.services.calendar,
      );
      this.services.metrics.record('promises_extracted', { count: rows.length, events: events.length, with_details: rows.filter((r) => r.details).length, ms: ms(t), open: open.length, changes: rows.filter((r) => r.change !== 'new').length, ...(byRules && { by_rules: byRules }) });
      return {
        ok: true,
        rows,
        author: authorIsMe ? null : (author?.name ?? author?.email ?? null),
        authorIsMe,
        identitySet: identity.name.trim().length > 0,
        byRules,
        open,
        events,
        sameDay,
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

  savePromises(sessionId: number, rows: PromiseSaveRow[], events: EventSaveRow[] = []): { saved: number; created: number; updated: number; events: number } {
    const s = this.current(sessionId);
    if (!s?.selection) throw new Error('This selection is gone. Select the message again.');
    for (const e of events) this.services.calendar.add(e, s.selection.source_app);
    const r = savePromises(this.services.people, rows, {
      message: s.selection.text,
      sourceApp: s.selection.source_app,
      authorPersonId: s.author?.personId ?? null,
      authorIsMe: s.author?.isMe ?? false,
    });
    this.services.metrics.record('promises_saved', { count: r.saved, created: r.created, updated: r.updated, events: events.length, offered: rows.length });
    log.info('promises saved', { ...r, events: events.length });
    return { ...r, events: events.length };
  }

  /** Person badges from tier 1 (local, a few ms): a known person with open commitments or a note. */
  private badgesFor(s: Session): OverlayState['badges'] {
    if (!s.selection) return [];
    const related = this.visibleRecall(s).length;
    const recall: OverlayState['badges'] = related > 0 ? [{ kind: 'recall', count: related }] : [];
    try {
      const detection = detectPeople(detectInputFor(s.selection, null), this.settings.identity, this.services.store.listKnownPeople());
      return [...personBadges(this.services.people, detection, s.selection.source_app), ...recall];
    } catch (e) {
      log.warn('person badges failed', errorInfo(e));
      return recall;
    }
  }

  // ---- Save modes (decision 15) ----

  /** Autosave: the highlight is saved to the rules' collection as the pill shows. */
  private autosave(s: Session): void {
    if (!s.selection || !s.fg) return;
    const last = this.lastAutosave;
    if (last && last.handle === s.fg.handle && last.text === s.selection.text) {
      // The same text is still selected: show that save again instead of saving twice.
      if (this.services.store.getItem(last.notice.itemId)) {
        s.saved = last.notice;
        s.savedSettled = true;
      }
      return;
    }
    const collection = this.router().quick(toContext(s.selection)).decisions.best_collection;
    const r = this.services.save.save({ selection: s.selection, container: null, collection, via: 'autosave' });
    void r.enriched.then((e) => log.info('save enriched', { embedded: e.embedded, entities: e.entities, skipped: e.entitiesSkipped ?? null, cancelled: e.cancelled }));
    s.saved = { itemId: r.item.id, collection, undoUntil: r.undoUntil, via: 'autosave' };
    this.lastAutosave = { handle: s.fg.handle, text: s.selection.text, notice: s.saved };
    log.info('autosaved');
  }

  /** When the route settles, an autosaved item moves to its collection once (the same choice as the Save label). */
  private settleAutosave(s: Session, collection: string): SavedNotice | null {
    const saved = s.saved;
    if (!saved || saved.via !== 'autosave' || s.savedSettled) return saved;
    s.savedSettled = true;
    if (collection === saved.collection) return saved;
    const moved = this.services.save.move(saved.itemId, collection);
    if (!moved) return saved;
    s.saved = { ...saved, collection: moved };
    if (this.lastAutosave?.notice.itemId === saved.itemId) this.lastAutosave.notice = s.saved;
    return s.saved;
  }

  undoSaved(sessionId: number): { undone: boolean } {
    const s = this.current(sessionId);
    if (!s?.saved) return { undone: false };
    const undone = this.services.save.undo(s.saved.itemId);
    if (this.lastAutosave?.notice.itemId === s.saved.itemId) this.lastAutosave = null;
    if (undone) {
      s.saved = null;
      if (this.state.mode === 'toast') this.close('toast_undone');
      else this.overlay.patch({ saved: null });
    }
    log.info('saved undo', { undone });
    return { undone };
  }

  /**
   * The save hotkey: saves the selection to the route's collection with no panel, and shows a
   * small toast with Undo that never takes focus. Passwords and empty selections are never saved.
   */
  async saveHotkey(): Promise<void> {
    this.services.metrics.record('save_hotkey');
    const settings = this.settings;
    const cursor = screen.getCursorScreenPoint();
    const t0 = performance.now();
    let fg: Foreground;
    let sel: CommandResult<'selection'> | null = null;
    try {
      fg = await this.helper.request('foreground');
      if (this.isOwn(fg)) return;
      const appId = { process_name: fg.process_name, title: fg.title };
      if (!gateApp(appId, 'hotkey', settings).ok) return;
      try {
        sel = await this.readSelection();
      } catch (e) {
        if (e instanceof HelperError && e.code === 'password_field') return;
      }
      if (sel?.is_password) return;
      let text = sel?.text ?? '';
      let method: SelectionPayload['method'] = sel?.method ?? 'uia';
      if (mayCopyFallback(sel, appId, settings)) {
        text = cleanText((await this.helper.request('copy_fallback', { timeout_ms: settings.capture.copyTimeoutMs })).text);
        method = 'copy';
      }
      if (!text.trim()) {
        this.showToast(null, sel?.bounds ?? null, cursor, 'Nothing is selected to save.');
        return;
      }
      const selection: SelectionPayload = {
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
      if (method !== 'copy') {
        const n = settings.capture.contextChars;
        const ctx = await this.helper.request('context', { before: n, after: n }).catch(() => null);
        if (ctx) {
          selection.context_before = cleanText(ctx.before, { trimEdges: false });
          selection.context_after = cleanText(ctx.after, { trimEdges: false });
        }
      }
      // The same choice as the Save label: the route's collection when it settles in time, else the rules'.
      const route = await this.router().route(toContext(selection));
      const collection = route.decisions.best_collection;
      const r = this.services.save.save({ selection, container: null, collection, via: 'hotkey' });
      void r.enriched.then((e) => log.info('save enriched', { embedded: e.embedded, entities: e.entities, skipped: e.entitiesSkipped ?? null, cancelled: e.cancelled }));
      log.info('saved by hotkey', { ms: ms(t0), fallback: route.fallback ?? 'none' });
      this.showToast({ itemId: r.item.id, collection, undoUntil: r.undoUntil, via: 'hotkey' }, sel?.bounds ?? null, cursor, null, fg);
    } catch (e) {
      if (!(e instanceof HelperError)) log.error('save hotkey failed', errorInfo(e));
    }
  }

  /** The small strip after the save hotkey. It shows inactive, so typing stays in the app. */
  private showToast(saved: SavedNotice | null, physBounds: Rect | null, cursor: Point, notice: string | null, fg: Foreground | null = null): void {
    this.endSession();
    const bounds = physBounds ? toDipRect(physBounds) : cursorRect(cursor);
    const anchor = physBounds ? { x: bounds.x + bounds.w, y: bounds.y + bounds.h } : cursor;
    const session: Session = {
      id: this.nextSessionId++,
      trigger: 'hotkey',
      t0: performance.now(),
      fg,
      selection: null,
      bounds,
      anchor,
      siteKey: null,
      tier1Read: false,
      container: null,
      route: null,
      routeCtl: null,
      asks: new Map(),
      timings: {},
      placement: null,
      obstacles: [],
      pill: null,
      promisesCtl: null,
      whoCtl: null,
      author: null,
      reply: null,
      recall: null,
      recallDismissed: new Set(),
      askRelated: null,
      focusEditable: null,
      surroundings: null,
      pasteCtl: null,
      saved,
      savedSettled: true,
      visualCtl: null,
      visual: null,
    };
    this.session = session;
    const placement = placeBar({ selection: bounds, anchor, obstacles: [], size: SIZES.toast, growW: SIZES.toast.w + 80, workArea: workArea(anchor) });
    this.overlay.update({ ...HIDDEN_STATE, sessionId: session.id, mode: 'toast', placement, saved, notice }, placement.rect);
    const ttl = saved ? Math.max(1500, saved.undoUntil - Date.now()) : 2000;
    setTimeout(() => {
      if (this.current(session.id) && this.state.mode === 'toast') this.close('toast_done');
    }, ttl);
  }

  // ---- Recall and search ----

  private recallDeps() {
    const sv = this.services;
    return { store: sv.store, embedder: () => sv.embed.embedder(), settings: () => sv.settings };
  }

  private visibleRecall(s: Session): RecallHit[] {
    return (s.recall ?? []).filter((h) => !s.recallDismissed.has(h.itemId));
  }

  /** Runs with the router (spec: Recall), on the selection; the badge appears when something is related. */
  private async runRecall(s: Session): Promise<void> {
    if (!s.selection || s.recall) return;
    const t = performance.now();
    try {
      const hits = await recallFor(this.recallDeps(), { text: s.selection.text, personIds: s.route?.features.knownPeople ?? [] });
      if (!this.current(s.id)) return;
      s.recall = hits;
      s.timings.recall = ms(t);
      if (hits.length === 0) return;
      this.overlay.patch({ badges: this.badgesFor(s), debug: this.debugFor(s) });
      this.services.metrics.record('recall_shown', {
        count: hits.length,
        entity: hits.filter((h) => h.reason !== 'similar_topic').length,
        ms: s.timings.recall,
      });
    } catch (e) {
      log.warn('recall failed', errorInfo(e));
    }
  }

  recallHits(sessionId: number): { hits: RecallHit[] } {
    const s = this.current(sessionId);
    return { hits: s ? this.visibleRecall(s) : [] };
  }

  dismissRecall(sessionId: number, itemId: string): void {
    const s = this.current(sessionId);
    const hit = s?.recall?.find((h) => h.itemId === itemId);
    if (!s || !hit) return;
    s.recallDismissed.add(itemId);
    this.services.metrics.record('recall_dismissed', { reason: hit.reason, ...(hit.similarity !== null && { similarity: Math.round(hit.similarity * 100) / 100 }) });
    this.overlay.patch({ badges: this.badgesFor(s) });
  }

  /** "Ask about these": Ask opens with the cards as its saved notes. */
  async askAboutRecall(sessionId: number): Promise<void> {
    const s = this.current(sessionId);
    if (!s) return;
    s.askRelated = this.visibleRecall(s).map((h) => h.itemId);
    await this.run(sessionId, { action: 'ask' });
  }

  async search(query: string): Promise<SearchResults> {
    return searchSaved({ ...this.recallDeps(), people: this.services.people, calendar: this.services.calendar }, query);
  }

  /** The Saved tab in Settings. Local, like the search box. */
  library(q: LibraryQuery): Promise<LibraryResult> {
    return librarySaved(this.recallDeps(), q);
  }

  /** Saved notes for Ask: the cards picked with "Ask about these", else the top recall hits. */
  private askNotes(s: Session): Item[] {
    const ids = s.askRelated ?? this.visibleRecall(s).slice(0, 3).map((h) => h.itemId);
    return this.services.store.itemsWithCollection(ids);
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
        const remember = {
          collections: this.services.collections(),
          suggested: s.route?.decisions.best_collection ?? 'Notes',
          save: (note: string, collection: string) => {
            const saved = this.services.save.saveNote({ text: note, collection, selection: s.selection });
            void saved.enriched.then((e) => log.info('save enriched', { embedded: e.embedded, entities: e.entities, skipped: e.entitiesSkipped ?? null, cancelled: e.cancelled }));
            send<AskSaved>('ask:saved', { requestId, itemId: saved.item.id, collection, undoUntil: saved.undoUntil });
            log.info('ask remembered');
            return { collection };
          },
        };
        const r = ask(this.services.llm, this.settings, { selection, container, question: q, related: this.askNotes(s), remember, surroundings: s.selection ? null : s.surroundings }, ctl.signal);
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
    if (focused && s.fg && reason !== 'blur' && reason !== 'settings' && !reason.endsWith('_inserted')) {
      void this.helper.request('restore_focus', { handle: s.fg.handle }).catch(() => {});
    }
  }

  /** A click outside a focused bar: close it unless the overlay is still the window in front (a dropdown or date picker it opened). */
  private async closeIfNotInFront(id: number | undefined): Promise<void> {
    if (id === undefined || this.session?.id !== id || !this.overlay.isVisible || !this.overlay.hasFocus || this.bouncing) return;
    if ((await this.overlayInFront()) !== false) return;
    if (this.session?.id !== id || !this.overlay.isVisible || this.bouncing) return;
    log.info('overlay was not in front');
    this.close('click_outside');
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
    // The save toast stays through typing and app switches; it closes on its timer, a click, or a scroll.
    if (this.state.mode === 'toast' && signal !== 'wheel') return;
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
    if (!shouldHideOverlay({ ...input, settling: false })) return;
    log.info('overlay hide suppressed', { reason: signal });
    // A focused bar ignores clicks outside and typing, so a blur swallowed by the grace has to
    // be looked at again when it ends: if Windows still hasn't given the bar focus, close it.
    if (signal === 'blur') {
      const id = this.session?.id;
      setTimeout(() => {
        const s = this.session;
        if (s && s.id === id && this.overlay.isVisible && this.overlay.hasFocus && !this.overlay.osFocused) this.activityHide('blur');
      }, Math.max(0, this.settleUntil - Date.now()) + 20);
    }
  }

  private endSession(): void {
    const s = this.session;
    this.stopWatch();
    if (!s) return;
    s.routeCtl?.abort();
    s.promisesCtl?.abort();
    s.whoCtl?.abort();
    s.pasteCtl?.abort();
    s.visualCtl?.abort();
    s.reply?.ctl.abort();
    if (s.reply?.done && !s.reply.used) this.services.metrics.record('reply_discarded');
    this.cancelAsks(s);
    this.session = null;
  }

  // ---- hide-on-activity watch (pill and unfocused bar) ----

  private cancelKeyHide(): void {
    if (this.keyHideTimer) clearTimeout(this.keyHideTimer);
    this.keyHideTimer = null;
  }

  private startWatch(): void {
    this.stopWatch();
    void this.setInputWatch(true);
    // How far the cursor was when the overlay appeared: a pill placed past a toolbar can start
    // farther away than the setting allows (decision 55).
    let limit: number | null = null;
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
      const away = distanceToRect(cursor, hit);
      limit ??= mouseAwayLimit(away, this.settings.capture.hideDistancePx);
      if (away > limit) this.activityHide('mouse_away');
    }, WATCH_INTERVAL_MS);
  }

  private stopWatch(): void {
    this.cancelKeyHide();
    if (this.watchTimer) clearInterval(this.watchTimer);
    this.watchTimer = null;
    void this.setInputWatch(false);
  }

  private async setInputWatch(enabled: boolean): Promise<void> {
    if (this.inputWatch === enabled || !this.helper.isReady) return;
    this.inputWatch = enabled;
    try {
      const r = await this.helper.request('input_watch', { enabled });
      // Once per helper: whether touch input is told apart from typing (decision 56).
      if (enabled && !this.touchLogged) {
        this.touchLogged = true;
        log.info('input watch', { touch: r.touch ?? false });
      }
    } catch {
      this.inputWatch = !enabled;
    }
  }

  // ---- state helpers ----

  private debugFor(s: Session): OverlayState['debug'] {
    if (!this.settings.debugView) return null;
    const sel = s.selection;
    // Nothing selected: the surroundings show as the context, split at the caret.
    const around = !sel && s.surroundings ? s.surroundings : null;
    const at = around ? (around.caret >= 0 ? around.caret : around.text.length) : 0;
    return {
      text: sel?.text ?? '',
      context_before: sel?.context_before ?? around?.text.slice(0, at) ?? '',
      context_after: sel?.context_after ?? around?.text.slice(at) ?? '',
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
