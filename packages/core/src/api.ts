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
import type { ApiStyle, AppMode, ModelRef, RoleName, Settings, SettingsKey } from './settings';
import type { CaptureMethod, Trigger } from './types';
import type { WhoView } from './actions/who';
import type { PasteTarget, WriteAsk, WriteSuggestion } from './actions/paste-types';
import type { PromisesByRules } from './actions/promises';
import type { CalendarEvent, EventPatch, EventCandidate, EventSaveRow } from './calendar/types';
import type { LibraryQuery, LibraryResult, RecallHit, SearchResults } from './recall/types';
import type { VisualizeResult } from './visualize/types';
import type { AliasKind, CommitmentStatus, CommitmentView, PersonCard, PersonSummary, PromiseSaveRow, PromiseRow, StyleNote, VoiceSample } from './people/types';
import type { PickDraft, ReplyChannel, ReplyRedo, StyleDimension, StylePole, StylePreference } from './people/reply-style';
import type { Relationship } from './people/relationship';

export type { CatalogModel, Capabilities, Price, Speed, Tier } from './llm/catalog';
export type { ApiStyle, ProviderConnection } from './settings';
export type { MetricsSummary } from './metrics';
export type { WhoEntry, WhoView } from './actions/who';
export type { DetectedPerson } from './people/detect';
export type * from './people/types';
export type { PickDraft, ReplyChannel, ReplyRedo, ReplyRedoAsk, StyleDimension, StylePole, StylePreference, StyleSource } from './people/reply-style';
export type { Relationship } from './people/relationship';
export type { PasteTarget, WriteAsk, WriteSuggestion } from './actions/paste-types';
export type { PromisesByRules } from './actions/promises';
export type * from './calendar/types';
export type { LibraryItem, LibraryQuery, LibraryResult, RecallHit, RecallReason, SearchResults } from './recall/types';
export type { Cell, FieldType, ParsedTable, VisualizeResult } from './visualize/types';
export type { AppMode, Identity, ModelRef, Privacy, RoleName, Settings, SettingsKey } from './settings';

// ---- overlay state (main -> overlay renderer) ----

/** Ask, Save, the slot-rule actions (see BarAction), and `recall`, the panel behind the Recall badge. */
export type ActionId = 'ask' | 'save' | BarAction | 'recall';

/** Actions with a working panel in this build; the rest show "Coming in a later phase". */
export type AvailableAction = 'ask' | 'save' | 'who' | 'promises' | 'reply' | 'visualize' | 'search' | 'recall' | 'write';

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
  /** "Save to {collection}", or the collection alone when that is too long (`saveLabel`). With nothing selected, Search (decision 82). */
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
  /**
   * The tallest the panel may be (DIP) so it stays inside the window the text came from; null
   * when the screen is the limit. The panel scrolls inside it (decision 44).
   */
  panelMaxH: number | null;
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
/** Ask saved a memory: asked to remember it, or on its own (decision 78). One per save; an answer can have several. */
export interface AskSaved {
  requestId: string;
  itemId: string;
  collection: string;
  /** Epoch ms. */
  undoUntil: number;
  /** A saved memory about the same fact was reworded instead of adding a copy; Undo puts the old wording back. */
  updated: boolean;
  /** False when Ask saved it without being asked (the answer doesn't mention it, so the panel shows the text). */
  asked: boolean;
  /** The memory, clipped. */
  text: string;
}
/**
 * Something Ask did or offers to do with its tools (decision 78): a task, an event, a line on a
 * person's note, or a fact about the user. Applied ones have Undo; offered ones a one-click Add.
 */
export interface AskAction {
  requestId: string;
  /** For `ask:action-accept` and `ask:action-undo`. */
  id: string;
  kind: 'task' | 'event' | 'person' | 'about';
  state: 'applied' | 'offered' | 'undone';
  /** "Send the deck to Jordan Hale, due tomorrow", "Lunch with Jordan, tomorrow, 1:00 PM to 2:00 PM". */
  label: string;
  /** Epoch ms; Undo works until then. Null while offered. */
  undoUntil: number | null;
}

/** One saved row that went into a prompt (decision 77), for the "Used N" chip. */
export interface ContextUsed {
  kind: 'note' | 'person' | 'task' | 'event';
  /** The item's, person's, task's, or event's id. */
  id: string;
  /** Short: a name, a title, or the start of a note. */
  label: string;
  /** "colleague", "open, due tomorrow", "today, 1:00 PM to 5:00 PM", or null. */
  detail: string | null;
}
/** What Ask put in the prompt from saved data; sent before the answer streams. */
export interface AskContext {
  requestId: string;
  used: ContextUsed[];
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
  /** What the drafts drew on from saved data (decision 77), for the "Used N" chip. */
  used?: ContextUsed[];
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
export interface StyleNoteView extends StyleNote {
  /** "in messaging apps", or null for everywhere. */
  where: string | null;
}
/** A kind of saved data Write here leaves out in one place, because the user keeps dropping it there (decision 81). */
export interface DroppedKindView {
  channel: ReplyChannel;
  kind: ContextUsed['kind'];
  /** "in email". */
  where: string;
}
export interface StyleView {
  learning: boolean;
  preferences: StylePreferenceView[];
  notes: StyleNoteView[];
  dropped: DroppedKindView[];
}
/** inserted: pasted into the source app. copied: on the clipboard instead (focus failed, or the focused field doesn't take text). */
export type ReplyInsertResult = { result: 'inserted' } | { result: 'copied'; reason: 'focus' | 'not_editable' | 'paste' };

// ---- Write here (nothing selected, decision 81) ----

/** A saved snippet for the Snippets view, in the order to paste it. */
export interface WriteSnippet {
  id: string;
  /** One line for the List form, already shaped for the place ("- " bullets or a plain line). */
  line: string;
  /** The snippet as saved (cleaned), for the As saved form. */
  full: string;
  /** "Notes · Oct 9": its collection and the day it was saved. */
  detail: string;
}

/** What the panel needs before anything is written: answered at once, with no model call. */
export interface WriteOpen {
  /** Where the cursor is: email, chat, document, code, or other. */
  target: PasteTarget;
  /** A Chat model is available; without one the panel shows only the Snippets view. */
  model: boolean;
  /** What a model call would refuse with (no key, Local only), to explain it in the Snippets view. */
  noModel: { code: AskErrorEvent['code']; message: string } | null;
  /** Text before the caret: the panel writes at once instead of asking what to write. */
  writing: boolean;
  /** Who the text goes to, when the field sits under someone's message. */
  to: string | null;
  /** For an empty field: things to write, built from saved data in code. */
  suggestions: WriteSuggestion[];
  snippets: WriteSnippet[];
  /** `related`: picked by meaning against the text around the cursor; `recent`: the newest ones. */
  reason: 'related' | 'recent';
  /**
   * The last request written for this spot in this session (decision 83), so a reopened panel asks
   * for it again and gets the cached text. Null when the last run continued the text, or none ran.
   */
  last: { request: string; label: string | null; suggested: boolean; recentSnippets: boolean } | null;
}

export interface WriteStartArgs {
  sessionId: number;
  /** What to write ("agenda for Thursday"); left out to continue the text at the caret. */
  request?: string;
  /** Rewrite the text written before: chips and/or typed words. */
  change?: { previous: string; asks: WriteAsk[]; note?: string };
  /** The request is a suggestion built in code, not the user's words, so nothing is learned from it. */
  suggested?: boolean;
  /** "Put back": kinds of saved data to use even though the user usually leaves them out here. */
  include?: ContextUsed['kind'][];
  /** The "notes from your newest snippets" suggestion: use the newest snippets, not only the ones close in meaning. */
  recentSnippets?: boolean;
  /** The heading for a request (a suggestion's label), kept so a reopened panel shows it again. */
  label?: string;
}
export interface WriteStart {
  /** Chunks, done, and errors arrive on write:chunk, write:done, and write:error with this id. */
  requestId: string;
  /** What the text drew on from saved data (decision 77), for the "Used N" chip. */
  used: ContextUsed[];
  to: string | null;
  /** Kinds of saved data left out because the user usually drops them in this place (decision 81). */
  leftOut: ContextUsed['kind'][];
  /** Set when this picks up a text already written for this spot (decision 83): the text so far, or all of it when it's finished. */
  resumed?: string;
}

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

/** One entry in the Add a provider list (decision 79); `ProviderPreset` in core without its code. */
export interface PresetInfo {
  id: string;
  label: string;
  group: 'free' | 'makers' | 'gateways' | 'hosts' | 'local' | 'custom';
  blurb: string;
  keyUrl: string;
  keyPlaceholder: string;
  free: boolean;
  /** Text goes through this service on its way to the model's maker. */
  via: boolean;
  baseUrl?: string;
  /** Something to know before adding it (Gemini's free tier and training, decision 80). */
  note?: string;
}

/** A provider the user added (decision 79), as the Models tab shows it. */
export interface ProviderStatus {
  /** The provider in model refs: the preset's id, or "custom-N". */
  id: string;
  preset: string;
  /** The preset's name, or a Custom provider's own. */
  label: string;
  /** A Custom provider's address. */
  baseUrl: string | null;
  /** How a Custom provider talks. */
  api: ApiStyle | null;
  via: boolean;
  free: boolean;
  note: string | null;
  keyUrl: string;
  keyPlaceholder: string;
  hasKey: boolean;
  /** Result of the last live test, if any. */
  lastTest: KeyTestResult | null;
}

/** What "Add provider" sends. `id` replaces the key or address of a provider already added. */
export interface ProviderAddArgs {
  preset: string;
  id?: string;
  key?: string;
  /** Custom only. */
  label?: string;
  baseUrl?: string;
  /** Custom only; left out to find out when testing. */
  api?: ApiStyle;
}

/** A local server found running at a preset's address (Ollama, LM Studio). */
export interface LocalFound {
  preset: string;
  baseUrl: string;
  /** Chat models it serves; 0 when it isn't running. */
  models: number;
  running: boolean;
}

export interface KeyTestResult {
  ok: boolean;
  /** The provider the test saved, on success ("custom-2" for a new Custom one). */
  id?: string;
  /** Roles that moved to another model because this provider was added (decision 80); hand-picked roles never move. */
  moved?: RoleMove[];
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
  presets: readonly { id: string; label: string; baseUrl: string }[];
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
  /** The hosted providers added, in order (decision 79). */
  providers: ProviderStatus[];
  /** Everything Add provider offers. */
  presets: PresetInfo[];
  local: LocalStatus;
  models: CatalogModel[];
  embed: EmbedStatus;
  /** Saved items no model has looked for people and places in yet (decision 44). */
  entitiesPending: number;
  platform: 'win32' | 'darwin' | 'linux';
  /** The installed app, not a dev build: starting at sign-in and updates only work there. */
  installed: boolean;
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

/** A role's automatic pick moved from one model to another. */
export interface RoleMove {
  role: RoleName;
  from: ModelRef;
  fromFallback: ModelRef | null;
  to: ModelRef | null;
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
  'overlay:resize': { args: { sessionId: number; w: number; h: number; popover?: boolean }; result: void };

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
  /** Adds a task or event Ask offered (decision 78). Null when the offer is gone (the bar closed). */
  'ask:action-accept': { args: { sessionId: number; id: string }; result: AskAction | null };
  /** Undoes something Ask did, inside its undo window. */
  'ask:action-undo': { args: { sessionId: number; id: string }; result: { undone: boolean } };
  /** "Not related" on a row of the "Used N" chip: left out of later prompts in this session, and logged (kind and reason only). */
  'context:dismiss': { args: { sessionId: number; kind: ContextUsed['kind']; id: string }; result: void };

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

  /** Write here: the place, the snippets that fit, and suggestions for an empty field. No model call. */
  'write:open': { args: { sessionId: number }; result: WriteOpen };
  /** Streams the text (Chat role) to the sender's write:* channels: continuing the caret's text, a request, or a change. */
  'write:start': { args: WriteStartArgs; result: WriteStart };
  'write:cancel': { args: { requestId: string }; result: void };
  /** Pastes the (possibly edited) text through the insert path, like Reply. */
  'write:insert': { args: { sessionId: number; mode: 'written' | 'snippets'; text: string; edited: boolean; original?: string }; result: ReplyInsertResult };

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
  /** Rewords a memory (decision 78; memories only), then embeds it again. False when it's gone or not a memory. */
  'items:edit': { args: { itemId: string; text: string }; result: { edited: boolean } };
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
  /** A task from quick add: the user's, owed to `person_id` when the person filter names one. */
  'commitments:add': { args: { text: string; due_at: string | null; person_id?: string | null }; result: void };
  /** Voice samples for Reply: pasted ones (at most 5) and the replies the user inserted. */
  'voice:list': { args: void; result: VoiceSample[] };
  'voice:add': { args: { text: string }; result: VoiceSample[] };
  'voice:remove': { args: { id: string }; result: VoiceSample[] };
  'voice:label': { args: { id: string; channel: ReplyChannel | null }; result: VoiceSample[] };
  /** What Reply and Write here learned from picks, edits, and asks, the style notes, and the kinds Write here leaves out. */
  'style:get': { args: void; result: StyleView };
  /** Forgets one learned preference (it can be learned again). An everywhere one passes its pole, with no place or person. */
  'style:forget': { args: { dimension: StyleDimension; channel: ReplyChannel | null; personId: string | null; relationship?: Relationship | null; pole?: StylePole }; result: StyleView };
  /** Removes a style note; it is not written again. */
  'style:note-remove': { args: { id: string }; result: StyleView };
  /** Write here shows this kind in this place again. */
  'style:forget-dropped': { args: { channel: ReplyChannel; kind: ContextUsed['kind'] }; result: StyleView };
  'commitments:set-status': { args: { id: string; status: CommitmentStatus }; result: void };

  'settings:get': { args: void; result: SettingsView };
  'settings:set': { args: { key: SettingsKey; value: unknown }; result: SetSettingResult };
  /** Adds a hosted provider, or replaces its key or address: saved (the key encrypted) only if the live test passes (decision 79). */
  'providers:add': { args: ProviderAddArgs; result: KeyTestResult };
  'providers:test': { args: { id: string }; result: KeyTestResult };
  /** Forgets the provider, its key, and its models. */
  'providers:remove': { args: { id: string }; result: void };
  /** Which local presets are running right now (a quick look at each default address). */
  'local:detect': { args: void; result: LocalFound[] };
  /** Lists the server's models; saves the address only if that works. */
  'local:connect': { args: { baseUrl: string }; result: KeyTestResult };
  'local:test': { args: void; result: KeyTestResult };
  /** Forgets the server and its models. */
  'local:remove': { args: void; result: void };
  /** The model Local only uses (`local.model`). */
  'local:model': { args: { model: ModelRef }; result: void };
  'models:refresh': { args: void; result: ModelsRefreshResult };
  'roles:set': { args: RoleSetArgs; result: Settings['roles'] };
  /** "Keep my previous models": puts moved roles back, as picked by hand so they stay (decision 80). */
  'roles:restore': { args: { moves: RoleMove[] }; result: Settings['roles'] };
  /** Shows a save dialog. Null when cancelled. */
  'data:export': { args: void; result: { path: string } | null };
  /** Deletes items, entities, people, vectors, events, and collections (re-seeded). Keys, settings, the model list, and the embedding model stay. */
  'data:delete-all': { args: void; result: void };
  /** Removes the saved keys, their test results, and the model list, resets settings to defaults (back to setup), and re-registers the default hotkey. Saved data stays. */
  'settings:reset': { args: void; result: void };
  'metrics:summary': { args: { days: number }; result: MetricsSummary };
  'embed:status': { args: void; result: EmbedStatus };
  'embed:download': { args: void; result: void };
  /** Finds people and places for items saved while no model could (decision 44). */
  'entities:backfill': { args: void; result: { done: number; left: number; error?: string } };
  /** `personId` (with tab "people") opens that person's full record. */
  'settings:open': { args: { tab?: SettingsTab; personId?: string }; result: void };
  /**
   * The setup's "Try it" step is showing: the settings window may be a capture source (it is
   * otherwise ignored like every Glossly window). Cleared when the window closes.
   */
  'setup:try-it': { args: { active: boolean }; result: void };
  /** The installed version and where updating stands (decision 70). */
  'updates:get': { args: void; result: UpdateView };
  /** Checks now; downloads too when `autoUpdate` is on. */
  'updates:check': { args: void; result: UpdateView };
  /** Downloads the update that was found (with `autoUpdate` off). */
  'updates:download': { args: void; result: void };
  /** Quits, installs the downloaded update, and starts Glossly again. */
  'updates:install': { args: void; result: void };
}

/**
 * Where updating stands. `unsupported` in a dev build (updates come with the installer);
 * `none` also covers a release feed that isn't there (a private repo answers 404).
 */
export type UpdateState =
  | { status: 'unsupported' }
  | { status: 'idle' }
  | { status: 'checking' }
  | { status: 'none'; checkedAt: string }
  | { status: 'available'; version: string }
  | { status: 'downloading'; version: string; percent: number }
  | { status: 'ready'; version: string }
  | { status: 'error'; kind: 'offline' | 'failed' };

export interface UpdateView {
  /** The running version ("0.1.0"). */
  current: string;
  state: UpdateState;
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
  'ask:context': AskContext;
  'ask:action': AskAction;
  'reply:chunk': AskChunk;
  'reply:done': AskDone;
  'reply:error': AskErrorEvent;
  'write:chunk': AskChunk;
  'write:done': AskDone;
  'write:error': AskErrorEvent;
  'embed:progress': EmbedStatus;
  'settings:changed': SettingsView;
  /** People, aliases, commitments, or interactions changed; views re-fetch. */
  'people:changed': Record<string, never>;
  /** Only while setup's Try it step is showing: the pill, bar, or an action ran on its own window (decision 11). */
  'setup:tried': { step: TryItStep };
  'updates:state': UpdateView;
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
