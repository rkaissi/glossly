/**
 * The IPC contract between shell-electron (main and preload) and the UI renderers. Types only:
 * the UI imports this as `@glossly/core/api` and must not pull in any runtime core code.
 *
 * Main owns the selection session. Renderers never send selection or context text back; they
 * refer to the current session by `sessionId`.
 */
import type { ClassifiedObstacle, ObstacleStatus } from './capture/obstacles';
import type { PillWaitReason } from './capture/pill-wait';
import type { Placement } from './capture/placement';
import type { EmbedProgress } from './embed/types';
import type { CatalogModel } from './llm/catalog';
import type { MetricsSummary } from './metrics';
import type { BarAction, ContentType, DecisionProviderId } from './router/types';
import type { AppMode, ModelRef, RoleName, Settings, SettingsKey } from './settings';
import type { CaptureMethod, Trigger } from './types';
import type { WhoView } from './actions/who';
import type { PasteFormat, PasteTarget } from './actions/paste-types';
import type { PromisesByRules } from './actions/promises';
import type { CalendarEvent, EventPatch, EventCandidate, EventSaveRow } from './calendar/types';
import type { LibraryQuery, LibraryResult, RecallHit, SearchResults } from './recall/types';
import type { VisualizeResult } from './visualize/types';
import type { AliasKind, CommitmentStatus, CommitmentView, PersonCard, PersonSummary, PromiseSaveRow, PromiseRow, StyleNote, VoiceSample } from './people/types';
import type { PickDraft, ReplyChannel, ReplyRedo, StyleDimension, StylePreference } from './people/reply-style';
import type { Relationship } from './people/relationship';

export type { CatalogModel, Capabilities } from './llm/catalog';
export type { MetricsSummary } from './metrics';
export type { WhoEntry, WhoView } from './actions/who';
export type { DetectedPerson } from './people/detect';
export type * from './people/types';
export type { PickDraft, ReplyChannel, ReplyRedo, ReplyRedoAsk, StyleDimension, StylePreference } from './people/reply-style';
export type { Relationship } from './people/relationship';
export type { PasteFormat, PasteTarget } from './actions/paste-types';
export type { PromisesByRules } from './actions/promises';
export type * from './calendar/types';
export type { LibraryItem, LibraryQuery, LibraryResult, RecallHit, RecallReason, SearchResults } from './recall/types';
export type { Cell, FieldType, ParsedTable, VisualizeResult } from './visualize/types';
export type { AppMode, Identity, ModelRef, Privacy, RoleName, Settings, SettingsKey } from './settings';

// ---- overlay state (main -> overlay renderer) ----

/** Ask, Save, the slot-rule actions (see BarAction), and `recall`, the panel behind the Recall badge. */
export type ActionId = 'ask' | 'save' | BarAction | 'recall';

/** Actions with a working panel in this build; the rest show "Coming in a later phase". */
export type AvailableAction = 'ask' | 'save' | 'who' | 'promises' | 'reply' | 'visualize' | 'search' | 'recall' | 'paste_list' | 'paste_summary';

/** `toast`: the small "Saved to Notes · Undo" strip after the save hotkey; it never takes focus. */
export type OverlayMode = 'hidden' | 'pill' | 'dot' | 'bar' | 'panel' | 'toast';

type ObstacleSide = ClassifiedObstacle['side'];

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
  /** Where the pill went (auto path), or null on the hotkey path. */
  placement: Placement['side'] | null;
  /** What popups_near found (auto path). Identifiers and sizes only, never text. */
  obstacles: ObstacleDebug[];
  /** How the auto pill waited for a selection toolbar, or null on the hotkey path. */
  pill: PillTiming | null;
}

export interface PillTiming {
  /** The app's wait: the last toolbar check starts this long after mouse-up. */
  wait_ms: number;
  reason: PillWaitReason;
  polls: number;
  /** A new toolbar was found, so the pill went to the other side before the wait was over. */
  found: boolean;
  /** The helper's mouse-down snapshot was there to diff against. */
  baseline: boolean;
}

export interface ObstacleDebug {
  source: 'window' | 'uia';
  kind: string;
  /** Size in DIP. */
  w: number;
  h: number;
  side: ObstacleSide;
  status: ObstacleStatus;
  class_name: string;
  process_name: string;
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

/** A save made without the Save panel: by the save hotkey (shown as a toast) or by autosave (the pill and bar show it). */
export interface SavedNotice {
  itemId: string;
  collection: string;
  /** Epoch ms. Undo works until then. */
  undoUntil: number;
  via: 'hotkey' | 'autosave';
}

export interface OverlayState {
  /** New for every selection; stale requests carrying an old id are ignored. */
  sessionId: number;
  mode: OverlayMode;
  placement: Placement | null;
  /** True on the hotkey path: the bar has keyboard focus and the keyboard map is live. */
  keyboard: boolean;
  /** The `keyHints` setting; the bar decides from it, once when it opens, whether to show key chips. */
  keyHints: 'always' | 'hotkey' | 'never';
  /** False for the "nothing selected" state (hotkey with no selection). */
  hasSelection: boolean;
  /** Word count only, for labels like "Ask about 42 words". */
  wordCount: number;
  /** The app or site name "Don't show here" stores and shows, e.g. "Slack", "Discord", or "Google Docs". */
  siteKey: string | null;
  /** This app or site opens the bar only on the hotkey, so the menu offers "Show here" instead. */
  hiddenHere: boolean;
  debug: SelectionDebug | null;
  slots: SlotsView | null;
  badges: Badge[];
  /** Panel open in the overlay, when mode is "panel". */
  panel: ActionId | null;
  /** One-time notice, e.g. a role's model went away. */
  notice: string | null;
  /** This selection is already saved (save hotkey or autosave); Save becomes Undo. */
  saved: SavedNotice | null;
  /** Nothing is selected and the focused control takes text, so a search result is inserted there instead of copied. */
  canInsert: boolean;
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
/** Ask saved a note because the question asked it to remember something. */
export interface AskSaved {
  requestId: string;
  itemId: string;
  collection: string;
  /** Epoch ms. */
  undoUntil: number;
}
export interface AskErrorEvent {
  requestId: string;
  code: 'no_model' | 'local_only' | 'invalid_output' | 'provider' | 'aborted' | 'timeout' | 'no_selection';
  message: string;
}

// ---- Reply ----

/** Who the drafts answer: the detected author, and their person record when they resolved. */
export interface ReplyTo {
  name: string | null;
  /** What detection found next to the author, to prefill "Add to people". */
  email: string | null;
  handle: string | null;
  personId: string | null;
  match: 'exact' | 'fuzzy' | 'none';
  /** The user wrote the selected message; the drafts are follow-ups. */
  authorIsMe: boolean;
}
export interface ReplyStart {
  /** Chunks, done, and errors arrive on reply:chunk, reply:done, and reply:error with this id. */
  requestId: string;
  to: ReplyTo;
  identitySet: boolean;
  /** The kind of platform, so "Add to people" can suggest a relationship (work chat: colleague). */
  channel: ReplyChannel;
  /** Set when this picks up drafts still being written for the same highlight: the text so far. */
  resumed?: string;
}
export interface ReplyInsertArgs {
  sessionId: number;
  text: string;
  /** The user changed the draft before inserting. */
  edited: boolean;
  /** Set when the user added the author to their people from the panel. */
  personId?: string;
  /** Which draft this came from, so Reply can learn from the pick. */
  pick?: ReplyPick;
}
/** The drafts as shown (text plus the model's kind and tone tags) and the one taken. Learned from, never stored as text. */
export interface ReplyPick {
  drafts: PickDraft[];
  chosen: number;
}

/** What Reply learned, for the Profile tab. */
export interface StylePreferenceView extends StylePreference {
  /** "Keeps replies short". */
  label: string;
  /** "in email", "with Jordan Hale". */
  where: string;
}
export interface StyleView {
  learning: boolean;
  preferences: StylePreferenceView[];
  notes: StyleNote[];
}
/** inserted: pasted into the source app. copied: on the clipboard instead (focus failed, or the focused field doesn't take text). */
export type ReplyInsertResult = { result: 'inserted' } | { result: 'copied'; reason: 'focus' | 'not_editable' | 'paste' };

// ---- Paste (nothing selected) ----

export type PasteKind = 'list' | 'summary';
export type PasteCompose =
  | {
      ok: true;
      text: string;
      /** List only: the snippets in full, as saved, for "As saved" in the panel. */
      asSaved?: string;
      /** Snippets used. */
      count: number;
      /** Snippets that were offered (the summary may use fewer). */
      total: number;
      /** Where the cursor is: email, chat, document, code, or other. */
      target: PasteTarget;
      /** `related`: picked by meaning against the text around the cursor; `recent`: the newest ones. */
      reason: 'related' | 'recent';
      /** Summary only: the shape the model wrote. */
      format?: PasteFormat;
    }
  | { ok: false; code: AskErrorEvent['code']; message: string };

// ---- Tasks (formerly What did I promise) ----

export type PromisesResult =
  | {
      ok: true;
      rows: PromiseRow[];
      /** Who wrote the message, as detected, or null. */
      author: string | null;
      authorIsMe: boolean;
      identitySet: boolean;
      /** Set when patterns found the rows because no model could be used (decision 34). */
      byRules: PromisesByRules;
      /** Open tasks with the people involved that no row is about (decision 36). */
      open: CommitmentView[];
      /** Events the message describes, and saved events on those days (decision 37). */
      events: EventCandidate[];
      sameDay: CalendarEvent[];
    }
  | { ok: false; code: AskErrorEvent['code']; message: string };

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

/** The local model server (Ollama, LM Studio), shown in the Keys tab. */
export interface LocalStatus {
  /** The server address, or null when none is set up. */
  baseUrl: string | null;
  /** The address is this computer, so Local only can use it (decision 34). */
  loopback: boolean;
  /** Result of the last connection test, if any. `models` counts its chat models. */
  lastTest: KeyTestResult | null;
  presets: readonly { label: string; baseUrl: string }[];
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
  local: LocalStatus;
  models: CatalogModel[];
  embed: EmbedStatus;
  platform: 'win32' | 'darwin' | 'linux';
  /** Built-in app lists, shown read-only next to the user's own entries. */
  builtins: { blockList: readonly string[]; hotkeyOnly: readonly string[] };
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

export type SettingsTab = 'tasks' | 'calendar' | 'people' | 'saved' | 'profile' | 'models' | 'privacy' | 'general' | 'metrics';

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
  'bar:show-here': { args: { sessionId: number }; result: { key: string; mode: AppMode } | null };
  /** Esc in a panel: back to the bar. */
  'bar:back': { args: { sessionId: number }; result: void };
  'bar:close': { args: { sessionId: number }; result: void };

  'ask:start': { args: AskStartArgs; result: { requestId: string } };
  'ask:cancel': { args: { requestId: string }; result: void };

  'save:save': { args: SaveArgs; result: SaveDone };
  'save:setWhy': { args: { itemId: string; why: string }; result: boolean };
  'save:undo': { args: { itemId: string }; result: { undone: boolean } };
  /** Undoes the session's save hotkey or autosave save (SavedNotice). */
  'saved:undo': { args: { sessionId: number }; result: { undone: boolean } };

  'clipboard:write': { args: { text: string }; result: void };
  /** "Copy as image": a PNG data URL rendered by the chart. */
  'clipboard:image': { args: { dataUrl: string }; result: void };

  /** Visualize: the table (parsed in code, else by the model) and a validated Vega-Lite spec. */
  'visualize:run': { args: { sessionId: number }; result: VisualizeResult };
  /** Saves the last Visualize result as a chart item in the route's collection. */
  'visualize:save': { args: { sessionId: number }; result: SaveDone };

  /** Streams three drafts (Chat role) to the sender's reply:* channels. With `redo`, three new ones after "None of these". */
  'reply:start': { args: { sessionId: number; redo?: ReplyRedo }; result: ReplyStart };
  'reply:cancel': { args: { requestId: string }; result: void };
  /** Gives focus back to the source window and pastes (spec: Inserting text). Never sends. */
  'reply:insert': { args: ReplyInsertArgs; result: ReplyInsertResult };
  /** Ctrl+C or the Copy button: counted for metrics only. */
  'reply:copied': { args: { sessionId: number; text?: string; pick?: ReplyPick; personId?: string }; result: void };

  /** The recent snippets as a plain list, or a summary from the Chat role. Nothing is pasted yet. */
  'paste:compose': { args: { sessionId: number; kind: PasteKind }; result: PasteCompose };
  /** Pastes the (possibly edited) text through the insert path, like Reply. */
  'paste:insert': { args: { sessionId: number; kind: PasteKind; text: string; edited: boolean }; result: ReplyInsertResult };

  /** One structured call (Fast role) for the commitments in the selection; due dates resolved in code. */
  'promises:extract': { args: { sessionId: number }; result: PromisesResult };
  /** Saves the rows the user kept. New people are created; the message is stored with its author. */
  'promises:save': {
    args: { sessionId: number; rows: PromiseSaveRow[]; events?: EventSaveRow[] };
    result: { saved: number; created: number; updated: number; events: number };
  };

  /** The Recall cards for the session's selection (spec: Recall), without the ones dismissed. Local. */
  'recall:get': { args: { sessionId: number }; result: { hits: RecallHit[] } };
  /** "Not related": hides the card for this selection and logs it (no text) for tuning. */
  'recall:dismiss': { args: { sessionId: number; itemId: string }; result: void };
  /** "Ask about these": opens Ask with the cards as its saved notes. */
  'recall:ask': { args: { sessionId: number }; result: void };
  /** The search box: saved items, people, and open commitments. Local. */
  'search:query': { args: { sessionId: number; query: string }; result: SearchResults };
  /** Copies a saved item's full text. */
  'items:copy': { args: { itemId: string }; result: void };
  /** The Saved tab in Settings: saved items by collection, searched by words and meaning. Local. */
  'library:query': { args: LibraryQuery; result: LibraryResult };
  /** Deletes a saved item for good (the Saved tab asks first), with its vector and orphaned entities. */
  'items:delete': { args: { itemId: string }; result: { deleted: boolean } };
  /** Moves a saved item to another collection (created if needed). Null when the item is gone. */
  'items:move': { args: { itemId: string; collection: string }; result: { collection: string | null } };
  /** Pastes a search result into the focused field (only offered when `canInsert`), else the clipboard. */
  'items:insert': { args: { sessionId: number; itemId: string }; result: ReplyInsertResult };

  /** The people in the session's selection: one Fast call when a model is available, then code keeps the rows. */
  'who:get': { args: { sessionId: number }; result: WhoView };

  // ---- people (overlay and settings) ----
  'people:list': { args: { query?: string }; result: PersonSummary[] };
  /** The full record: more interactions and saved items than the overlay card. */
  'people:card': { args: { personId: string }; result: PersonCard | null };
  'people:create': { args: { name: string; email?: string; handle?: string; note?: string; relationship?: Relationship | null }; result: PersonCard };
  /** "Is this the same Sam?" answered yes: the detected name, email, and handle become aliases. */
  'people:confirm-same': { args: { personId: string; name?: string; email?: string; handle?: string }; result: PersonCard };
  'people:update': { args: { personId: string; name?: string; note?: string | null; relationship?: Relationship | null }; result: PersonCard };
  /** The kind is guessed from the value unless given ("a@b.c" email, "@x" handle, else name). */
  'people:alias-add': { args: { personId: string; value: string; kind?: AliasKind }; result: PersonCard };
  'people:alias-remove': { args: { personId: string; kind: AliasKind; value: string }; result: PersonCard };
  /** Only after the user confirmed: folds dropId into keepId. */
  'people:merge': { args: { keepId: string; dropId: string }; result: PersonCard };
  'people:delete': { args: { personId: string }; result: void };
  'commitments:list': { args: { status?: CommitmentStatus; personId?: string }; result: CommitmentView[] };
  /** Edits a task's text or due date (a new date gets a new reminder). */
  'commitments:update': { args: { id: string; text?: string; due_at?: string | null }; result: void };
  'commitments:delete': { args: { id: string }; result: void };
  /** Calendar events for the Agenda tab, by day range ("YYYY-MM-DD", inclusive) and person. */
  'calendar:list': { args: { from?: string; to?: string; personId?: string }; result: CalendarEvent[] };
  /** An event typed in the Calendar tab. */
  'calendar:add': { args: EventSaveRow; result: CalendarEvent };
  'calendar:update': { args: { id: string; patch: EventPatch }; result: void };
  'calendar:delete': { args: { id: string }; result: void };
  /** A personal todo typed in the Agenda tab: owner "me", no person. */
  'commitments:add': { args: { text: string; due_at: string | null }; result: void };
  /** Voice samples for Reply: pasted ones (at most 5) and the replies the user inserted. */
  'voice:list': { args: void; result: VoiceSample[] };
  'voice:add': { args: { text: string }; result: VoiceSample[] };
  'voice:remove': { args: { id: string }; result: VoiceSample[] };
  /** What Reply learned from picks and edits, and the style notes. */
  'style:get': { args: void; result: StyleView };
  /** Forgets one learned preference (it can be learned again). */
  'style:forget': { args: { dimension: StyleDimension; channel: ReplyChannel | null; personId: string | null; relationship?: Relationship | null }; result: StyleView };
  /** Removes a style note; it is not written again. */
  'style:note-remove': { args: { id: string }; result: StyleView };
  'commitments:set-status': { args: { id: string; status: CommitmentStatus }; result: void };

  'settings:get': { args: void; result: SettingsView };
  'settings:set': { args: { key: SettingsKey; value: unknown }; result: SetSettingResult };
  /** Saves the key (encrypted) only if the live test passes. */
  'keys:add': { args: { provider: string; key: string }; result: KeyTestResult };
  'keys:test': { args: { provider: string }; result: KeyTestResult };
  'keys:remove': { args: { provider: string }; result: void };
  /** Lists the server's models; saves the address only if that works. */
  'local:connect': { args: { baseUrl: string }; result: KeyTestResult };
  'local:test': { args: void; result: KeyTestResult };
  /** Forgets the server and its models. */
  'local:remove': { args: void; result: void };
  /** The model Local only uses (`local.model`). */
  'local:model': { args: { model: ModelRef }; result: void };
  'models:refresh': { args: void; result: ModelsRefreshResult };
  'roles:set': { args: RoleSetArgs; result: Settings['roles'] };
  /** Shows a save dialog. Null when cancelled. */
  'data:export': { args: void; result: { path: string } | null };
  /** Deletes items, entities, people, vectors, events, and collections (re-seeded). Keys, settings, the model list, and the embedding model stay. */
  'data:delete-all': { args: void; result: void };
  /** Removes the saved keys, their test results, and the model list, resets settings to defaults (back to setup), and re-registers the default hotkey. Saved data stays. */
  'settings:reset': { args: void; result: void };
  'metrics:summary': { args: { days: number }; result: MetricsSummary };
  'embed:status': { args: void; result: EmbedStatus };
  'embed:download': { args: void; result: void };
  /** `personId` (with tab "people") opens that person's full record. */
  'settings:open': { args: { tab?: SettingsTab; personId?: string }; result: void };
  /**
   * The setup's "Try it" step is showing: the settings window may be a capture source (it is
   * otherwise ignored like every Glossly window). Cleared when the window closes.
   */
  'setup:try-it': { args: { active: boolean }; result: void };
}

/** What the setup's Try it step saw happen on its sample message, in the order a user meets them. */
export type TryItStep = 'pill' | 'bar' | 'action';

/** Main -> renderer pushes (webContents.send / ipcRenderer.on). */
export interface PushChannels {
  'overlay:state': OverlayState;
  'ask:chunk': AskChunk;
  'ask:done': AskDone;
  'ask:error': AskErrorEvent;
  'ask:saved': AskSaved;
  'reply:chunk': AskChunk;
  'reply:done': AskDone;
  'reply:error': AskErrorEvent;
  'embed:progress': EmbedStatus;
  'settings:changed': SettingsView;
  /** People, aliases, commitments, or interactions changed; views re-fetch. */
  'people:changed': Record<string, never>;
  /** Only while setup's Try it step is showing: the pill, bar, or an action ran on its own window (decision 11). */
  'setup:tried': { step: TryItStep };
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
