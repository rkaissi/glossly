/**
 * The IPC contract between shell-electron (main and preload) and the UI renderers. Types only:
 * the UI imports this as `@glossly/core/api` and must not pull in any runtime core code.
 *
 * Main owns the selection session. Renderers never send selection or context text back; they
 * refer to the current session by `sessionId`.
 */
import type { Placement } from './capture/placement';
import type { EmbedProgress } from './embed/types';
import type { CatalogModel } from './llm/catalog';
import type { MetricsSummary } from './metrics';
import type { ContextualAction, ContentType, DecisionProviderId } from './router/types';
import type { AppMode, ModelRef, RoleName, Settings, SettingsKey } from './settings';
import type { CaptureMethod, Trigger } from './types';

// ---- overlay state (main -> overlay renderer) ----

export type ActionId = 'ask' | 'save' | ContextualAction;

/** Actions with a working panel in this build; the rest show "Coming in a later phase". */
export type AvailableAction = 'ask' | 'save';

export type OverlayMode = 'hidden' | 'pill' | 'dot' | 'bar' | 'panel';

/** What the debug view shows. Only present when settings.debugView is on. */
export interface SelectionDebug {
  text: string;
  context_before: string;
  context_after: string;
  method: CaptureMethod;
  trigger: Trigger;
  source_app: string;
  window_title: string;
  is_editable: boolean;
  /** ms per capture stage, e.g. { selection: 12, popups_near: 4 }. */
  timings: Record<string, number>;
}

export interface SlotView {
  action: ActionId;
  label: string;
  /** 0 to 1 for contextual actions. */
  score?: number;
  /** False for later-phase actions. */
  available: boolean;
}

export interface SlotsView {
  /** Always Ask. */
  slot1: SlotView;
  /** Always "Save to {collection}". */
  slot2: SlotView & { collection: string };
  slot3: SlotView | null;
  slot4: SlotView | null;
  more: SlotView[];
  /** "rules" after Router.quick, "model" or "rules_fallback" after Router.route. */
  stage: 'pending' | 'rules' | 'model' | 'rules_fallback';
  content_type: ContentType | null;
  provider: DecisionProviderId | null;
  fallback: null | 'local_only' | 'no_model' | 'timeout' | 'error';
  route_ms: number | null;
}

export type Badge = { kind: 'recall'; count: number } | { kind: 'person'; personId: string; label: string };

export interface OverlayState {
  /** New for every selection; stale requests carrying an old id are ignored. */
  sessionId: number;
  mode: OverlayMode;
  placement: Placement | null;
  /** True on the hotkey path: the bar has keyboard focus and the keyboard map is live. */
  keyboard: boolean;
  /** False for the "nothing selected" state (hotkey with no selection). */
  hasSelection: boolean;
  /** Word count only, for labels like "Ask about 42 words". */
  wordCount: number;
  /** Key "Don't show here" would set to hotkey-only, e.g. "slack.exe" or "- Google Docs". */
  siteKey: string | null;
  debug: SelectionDebug | null;
  slots: SlotsView | null;
  badges: Badge[];
  /** Panel open in the overlay, when mode is "panel". */
  panel: ActionId | null;
  /** One-time notice, e.g. a role's model went away. */
  notice: string | null;
}

// ---- Ask ----

export interface AskStartArgs {
  sessionId: number;
  /** Empty means the default question. */
  question: string;
}
export interface AskChunk {
  requestId: string;
  text: string;
}
export interface AskDone {
  requestId: string;
  /** The model that answered, after any fallback. */
  model: ModelRef;
}
export interface AskErrorEvent {
  requestId: string;
  code: 'no_model' | 'invalid_output' | 'provider' | 'aborted' | 'timeout' | 'no_selection';
  message: string;
}

// ---- Save ----

export interface SaveArgs {
  sessionId: number;
  collection: string;
  why?: string;
}
export interface SaveDone {
  itemId: string;
  collection: string;
  /** Epoch ms. */
  undoUntil: number;
}

// ---- settings ----

export interface KeyStatus {
  provider: string;
  label: string;
  keyUrl: string;
  free: boolean;
  keyPlaceholder: string;
  hasKey: boolean;
  /** Result of the last live test, if any. */
  lastTest: KeyTestResult | null;
}

export interface KeyTestResult {
  ok: boolean;
  /** Number of chat models the key can use. */
  models: number;
  /** The provider's own error message on failure. Never contains the key. */
  error?: string;
  status?: number;
  at: string;
}

export interface EmbedStatus {
  model: string;
  dims: number;
  state: 'not_downloaded' | EmbedProgress['status'];
  progress?: number;
  message?: string;
  /** Items still waiting for an embedding. */
  pending: number;
}

export interface SettingsView {
  settings: Settings;
  collections: string[];
  keys: KeyStatus[];
  models: CatalogModel[];
  embed: EmbedStatus;
  platform: 'win32' | 'darwin' | 'linux';
}

export interface SetSettingResult {
  settings: Settings;
  /** E.g. "That hotkey is taken by another app." The old value is kept. */
  error?: string;
}

export interface ModelsRefreshResult {
  models: CatalogModel[];
  notices: string[];
  /** Providers whose listing failed, with the provider's message. */
  errors: { provider: string; message: string }[];
}

export interface RoleSetArgs {
  role: RoleName;
  /** For "decision", null means "Use Fast model". */
  model: ModelRef | null;
  fallback: ModelRef | null;
}

// ---- channel maps ----

/** Renderer -> main request/response (ipcRenderer.invoke / ipcMain.handle). */
export interface InvokeChannels {
  'overlay:get': { args: void; result: OverlayState };
  /** Renderer measured its content; main resizes and re-places the window. */
  'overlay:resize': { args: { sessionId: number; w: number; h: number }; result: void };

  'bar:expand': { args: { sessionId: number }; result: void };
  /** Runs the action in a slot (1 to 4) or by id (from "More"). Opens its panel. */
  'bar:run': { args: { sessionId: number; slot: 1 | 2 | 3 | 4 } | { sessionId: number; action: ActionId }; result: void };
  'bar:dont-show-here': { args: { sessionId: number }; result: { key: string; mode: AppMode } | null };
  /** Esc in a panel: back to the bar. */
  'bar:back': { args: { sessionId: number }; result: void };
  'bar:close': { args: { sessionId: number }; result: void };

  'ask:start': { args: AskStartArgs; result: { requestId: string } };
  'ask:cancel': { args: { requestId: string }; result: void };

  'save:save': { args: SaveArgs; result: SaveDone };
  'save:setWhy': { args: { itemId: string; why: string }; result: boolean };
  'save:undo': { args: { itemId: string }; result: { undone: boolean } };

  'clipboard:write': { args: { text: string }; result: void };

  'settings:get': { args: void; result: SettingsView };
  'settings:set': { args: { key: SettingsKey; value: unknown }; result: SetSettingResult };
  /** Saves the key (encrypted) only if the live test passes. */
  'keys:add': { args: { provider: string; key: string }; result: KeyTestResult };
  'keys:test': { args: { provider: string }; result: KeyTestResult };
  'keys:remove': { args: { provider: string }; result: void };
  'models:refresh': { args: void; result: ModelsRefreshResult };
  'roles:set': { args: RoleSetArgs; result: Settings['roles'] };
  /** Shows a save dialog. Null when cancelled. */
  'data:export': { args: void; result: { path: string } | null };
  'data:delete-all': { args: void; result: void };
  'metrics:summary': { args: { days: number }; result: MetricsSummary };
  'embed:status': { args: void; result: EmbedStatus };
  'embed:download': { args: void; result: void };
  'settings:open': { args: { tab?: 'keys' | 'models' | 'general' | 'data' | 'metrics' }; result: void };
}

/** Main -> renderer pushes (webContents.send / ipcRenderer.on). */
export interface PushChannels {
  'overlay:state': OverlayState;
  'ask:chunk': AskChunk;
  'ask:done': AskDone;
  'ask:error': AskErrorEvent;
  'embed:progress': EmbedStatus;
  'settings:changed': SettingsView;
}

export type InvokeChannel = keyof InvokeChannels;
export type PushChannel = keyof PushChannels;
export type InvokeArgs<C extends InvokeChannel> = InvokeChannels[C]['args'];
export type InvokeResult<C extends InvokeChannel> = InvokeChannels[C]['result'];

/** What the preload exposes as `window.glossly` via contextBridge. */
export interface GlosslyBridge {
  invoke<C extends InvokeChannel>(
    channel: C,
    ...args: InvokeArgs<C> extends void ? [] : [InvokeArgs<C>]
  ): Promise<InvokeResult<C>>;
  /** Returns an unsubscribe function. */
  on<C extends PushChannel>(channel: C, listener: (payload: PushChannels[C]) => void): () => void;
}
