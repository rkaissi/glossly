# Architecture

How Glossly is put together: the processes, the packages, and where each concern lives. For what each feature does, see `docs/features.md`. For why things are the way they are, see `docs/decisions.md`.

## Processes

```
 C# helper (helpers/windows)          Electron main (packages/shell-electron/src/main)
 glossly-helper.exe                    tray, hotkeys, capture session, IPC, services
   mouse hook, UIA reads,   <-- JSON lines over stdin/stdout -->   HelperClient (core)
   clipboard, focus, popups                       |
                                                  +-- utilityProcess: embed-worker (transformers.js)
                                                  +-- overlay window   (packages/ui overlay.html)
                                                  +-- settings window  (packages/ui settings.html)
```

- **Helper** (`helpers/windows/`, .NET 10, FlaUI.UIA3 plus raw `IUIAutomation` interop). A JSON-lines loop: one request at a time on the MTA main thread, a queued stdout writer thread so the hook callback never blocks, a `ready` event on start, exit on stdin EOF. The mouse hook and the mouse-down baseline snapshot (`Baseline.cs`) run on their own threads. `helpers/protocol.md` documents every command, error code, and event; read it before touching helper code. Commands: `selection`, `context`, `context_container`, `context_caret`, `copy_fallback`, `paste`, `foreground`, `restore_focus`, `focus_field`, `popups_near`, `baseline`, `window_corners`, `mouse_hook`, `input_watch`. Password fields are always refused.
- **Main** owns the selection. Renderers refer to it by `sessionId` and never send text back, except `clipboard:write` for Ctrl+C in a panel.
- **Embed worker**: a `utilityProcess` running `@glossly/core/embed`. Starts at launch if the model is downloaded (meta `embed_downloaded`) or setup is finished, otherwise on `embed:download`, then backfills `itemsWithoutVectors`.
- **Overlay**: one transparent, frameless, `focusable:false`, always-on-top (`pop-up-menu`) window, created once and shown with `showInactive`. It takes focus only on the hotkey path or for panels that need typing.
- **Settings window**: a normal framed window with mica, title "Glossly". The only window with a taskbar button.

## Packages

pnpm monorepo. `@glossly/core` ships TypeScript and is bundled into main by electron-vite. Imports are extensionless (bundler resolution). Prompts are loaded with `?raw` (`core/src/env.d.ts`).

### `packages/core` (OS-neutral, no Electron)

| Folder | What's there |
| --- | --- |
| `types.ts`, `settings.ts` | Shared types (`SelectionPayload`, `ContainerContext`, `Item`, `Surroundings`, `isoNow()`). `SettingsSchema` (Zod, every tunable with defaults), `parseSettings()` (keeps valid keys, defaults bad ones), `DEFAULT_COLLECTIONS`, `SETTINGS_MIGRATIONS`. |
| `api.ts` | The IPC contract: `InvokeChannels`, `PushChannels`, `OverlayState`, `GlosslyBridge` (what the preload exposes as `window.glossly`). Re-exports the types the UI needs, so `packages/ui` never imports `@glossly/core` itself. |
| `helper/` | Zod schemas per helper command (`Commands[cmd].args/result`, `EventSchema`) and `HelperClient` (typed `request`, per-command timeouts, result validation, `HelperError`). |
| `capture/` | `apps.ts` (block list, hotkey-only defaults, `siteKeyFor`, `keyMatches`, `resolveAppMode`), `gating.ts`, `placement.ts` (`placePill`, `placeBar`, `leftEdge`), `obstacles.ts` (baseline diff), `pill-wait.ts` (toolbar wait and learning), `clean.ts` (`cleanText`). |
| `router/` | `features.ts` (`extractFeatures`, `chatSpeaker`), `rules.ts`, `llm-decision.ts` (`LlmStructuredDecision`), `slots.ts` (`scoreActions`, `scoreEmptyActions`, `rankSlots`), `router.ts` (`quick()` for the instant rules paint, `route()` racing the model against the budget). |
| `store/` | `migrations.ts` (5 migrations, `PRAGMA user_version`), `store.ts` (`Store`: meta, settings, collections, items, entities, vectors, events, model catalog, export, delete-all, reset), `people.ts` (`PeopleRepo`: people, aliases, interactions, commitments (tasks; `commitments({personIds})`, `updateCommitment`), voice samples, style signals), `calendar.ts` (`CalendarRepo`: events, their people, `dueReminders`). |
| `llm/` | `providers.ts` (Groq, OpenAI, Anthropic; `listModels` doubles as the key test; `LocalProvider` for an OpenAI-compatible local server, `normalizeBaseUrl`, `isLoopbackUrl`), `catalog.ts` and `models/capabilities.json` (structured mode, reasoning effort, tools, cost/speed/tier, role preferences), `roles.ts` (`updateRoles`, `updateLocalModel`, `modelChain`), `llm.ts` (`AiSdkLlm`, `privacyChain`). |
| `actions/` | `ask.ts`, `save.ts` (`SaveService`), `context.ts` (`contextWindow`), `who.ts`, `promises.ts`, `promise-rules.ts` (tasks without a model, `matchOpenTasks`), `reply.ts`, `style-notes.ts`, `paste.ts`, `paste-types.ts`. |
| `calendar/` | `when.ts` (`splitRange`, `resolveEventTime`), `events.ts` (`ExtractedEventSchema`, `toEventRows`, `isEventSentence`, `rulesEvents`), `types.ts` (`CalendarEvent`, `EventCandidate`, `EventSaveRow`). |
| `people/` | (`canonicalize`, `jaroWinkler`, `isMe`), `detect.ts` (local detection), `resolve.ts`, `who-judge.ts`, `emails.ts`, `dates.ts` (`resolveDue`), `relationship.ts`, `reply-style.ts`, `types.ts`. |
| `recall/` | `recall.ts`: Recall ranking, search, and the Saved tab's `library()`. |
| `visualize/` | `table.ts` (parsing), `visualize.ts` (chart pick, `specFromChoice`, schema validation with Ajv). |
| `embed/` | `Embedder` type and `createTransformersEmbedder` (exported separately as `@glossly/core/embed`, not from `index.ts`). |
| `metrics.ts` | `Metrics`: `record()` never throws, payloads sanitized, `summary(days)` with per-feature counts. |
| `prompts/*.md` | One prompt per model call: `router-decision`, `ask`, `extract-entities`, `who`, `extract-commitments`, `reply`, `style-notes`, `paste-compose`, `visualize-table`, `visualize-chart`. |

### `packages/shell-electron` (Electron main and preload)

- `index.ts`: single-instance lock (a second launch calls `app.exit(0)` and the running one opens Settings), wiring, tray, hotkeys, first run (opens `#setup` while `firstRunComplete` is false), `setAppUserModelId('com.glossly.app')`.
- `services.ts`: Store, settings cache and `setSetting` (Zod per key), `AiSdkLlm`, `SaveService`, `Metrics`, `PeopleRepo`, keys, catalog refresh (24 h), role updates, delete-all and reset.
- `capture.ts`: the capture session. Auto and hotkey paths, expand, routing merge, tier-2 reads, every action's main-side half, insert and paste, save modes, the close logic and its reasons, and the Who/Visualize/Reply caches. The largest file; most behavior bugs land here.
- `overlay.ts` (window, `SIZES`, `MAX_W` 680, material and DWM corners, `resize()`), `view.ts` (pure helpers: slot labels, `growFrom`, `fitOnScreen`, `Lru`, `ExpiringLru`, `replyCacheKey`; unit tested), `helper-manager.ts` (spawn, restart with 0.5 to 10 s backoff, re-send `mouse_hook` and corners on `ready`), `hotkey.ts` (main hotkey and `SaveHotkey`), `ipc.ts` (every invoke handler; accepts only the overlay or settings webContents), `keys.ts` (`safeStorage` files, decrypted keys in memory only), `reminders.ts`, `tray.ts` (icon drawn in code), `settings-window.ts`, `embed-host.ts`/`embed-worker.ts`, `paths.ts`, `log.ts` (codes and timings only), `smoke.ts`.
- `electron.vite.config.ts`: main has two entries (`index`, `embed-worker`); `sqlite-vec` and `@huggingface/transformers` stay external. The preload is CJS (`out/preload/index.cjs`) so windows can be sandboxed. The renderer root is `../ui` with two pages. A build-only plugin injects a strict CSP (`script-src 'self'`; the dev server needs an inline refresh script).

### `packages/ui` (React 19 renderers)

- `overlay/`: `main.tsx` (`Overlay`, `Expanded` keyed by `sessionId`), `keys.ts` (pure keyboard map), one panel per action (`AskPanel`, `SavePanel`, `WhoPanel`, `PromisesPanel`, `ReplyPanel`, `RecallPanel`, `SearchPanel`, `PastePanel`, `VisualizePanel`, `LaterPanel` for actions that land before their panel), `SavedToast`, `Debug`, `markdown.ts` and `AnswerText` (React elements only, never HTML), `drafts.ts` (Reply's streaming parser), `badges.ts`.
- `settings/`: `useLive.ts` (re-fetch on `people:changed`), `main.tsx` (routes on `location.hash`: `#setup`, `#agenda`, `#people[/<id>]`, `#saved`, `#profile`, `#models`, `#privacy`, `#general`, `#metrics`; `#keys` and `#data` open Models and Privacy and data), `Setup.tsx` and one file per tab (`Keys.tsx` keeps the key and local model cards that Models and Setup show; `Data.tsx` holds the Privacy and data tab), `format.ts` (pure helpers), `useAction.ts`.
- `controls/` (Step 20.1, decision 39): our own controls for both windows: `Popover` (the one floating layer), `Menu` (`MenuList`, `ActionMenu`), `Select`, `Calendar`, `DatePicker` (field or row chip), `DateRangePicker`, `TimePicker`, and `Toggles` (`Segmented`, `Checkbox`, `TaskCheck`, `Switch`, `ChoiceCards`); `logic.ts` holds the tested parts (placement, menu keys and type-ahead, the month grid, ranges, time parsing); `room.ts` is the overlay's `RoomContext`; `controls.css` styles them. Triggers carry `data-control` so panel key maps leave them alone.
- `people/PersonCard.tsx` (shared by both windows), `theme.css` (tokens for both windows: colors, the 4 px spacing scale `--s-1`…`--s-6`, control heights `--h-sm/md/lg`, radii, row sizes, and the button styles), `icons.tsx` (`ActionIcon`, `GlosslyMark`), `dates.ts`.
- Component files export only components (otherwise React Fast Refresh falls back to a full reload).

## The capture pipeline

1. **Auto path.** Helper `mouse_up` (drag or double-click, outside the overlay and Glossly's pids) → `foreground` → `gateApp` (block list, per-app modes, hotkey-only apps) → `selection` → `gateAutoSelection` → `baseline` (the helper's own mouse-down snapshot) → `pollForToolbar` with `popups_near` → `placePill` → show inactive. A generation counter drops stale captures.
2. **Hotkey path.** `foreground` → `selection` → `copy_fallback` if `mayCopyFallback` → `context` (tier 1) → bar shown focused. Nothing selected: `context_caret` reads the surroundings (text around the caret, or visible text) before the bar takes focus.
3. **Expand.** Tier 1 → `Router.quick` paints Ask and Save → `Router.route` fills slots 3 and 4 (`mergeRoute`). Recall and person badges are computed alongside, locally.
4. **Action click.** Records `action_clicked {action, ms}`, reads tier 2 once (`context_container`, with the focus hand-off on the hotkey path), opens the panel.
5. **Insert.** `insertText`: `restore_focus` on the source, check the focused element is editable (Reply can `focus_field` to find the reply box), close, `paste`. Any failure puts the text on the clipboard with a note.

Context tiers: **tier 1** is `capture.contextChars` (500) around the selection, read on expand. **Tier 2** is up to `capture.containerChars` (8000) of the container (the email, the chat thread), read on action click. Coordinates from the helper are physical pixels; convert with `screen.screenToDipRect`.

## Routing and slots

The bar is: Glossly menu, Ask (slot 1), Save (slot 2), then slots 3 and 4, then badges. `rankSlots` is the one rule for every action: the top two scores above `router.slotThreshold` (0.5) take slots 3 and 4, the rest above `router.moreThreshold` (0.2) go under More (in the menu); never a third visible slot. Contextual actions are `reply`, `who`, `promises`, `visualize` (`CONTEXTUAL_ACTIONS`); the empty bar's are `search`, `paste_list`, `paste_summary` (`EMPTY_ACTIONS`). **To add an action:** add its id to one of those lists in `router/types.ts`, give it a 0 to 1 score in `slots.ts`, and the bar, More, keyboard map, and merge all follow. Recall is a badge, not a slot.

`Router.route` returns a `fallback` reason (`local_only`, `no_model`, `timeout`, `error`) when it used rules.

## LLM layer

- **Roles**: `fast`, `chat`, `decision` (null = use Fast), each `{model, fallback, manual}`, model refs like `groq:qwen/qwen3.8-27b` or `local:qwen3:8b`. Per-action overrides in `actionModels`. `local` holds the local server's `baseUrl` and the Local only model (`model`, `manual`). Services gives the local provider an empty key once a `baseUrl` is saved; `local:connect`, `local:test`, `local:remove`, and `local:model` manage it.
- **`AiSdkLlm`**: `stream` and `structured`. Falls back to the role's fallback model on 429 or 5xx only before the first token. Structured calls retry once with the validation error appended. JSON mode (no native schema) puts the JSON Schema in the instructions. Reasoning effort per model from `capabilities.json`. Enforces the privacy choice (decisions 12 and 34): under Local only `privacyChain` keeps only local models on a loopback address, and with none a call fails with `local_only` before anything is sent; `hasModel` answers under the same rule, which is how Who, Visualize, and Tasks pick their code paths. A local call with no HTTP answer becomes "Couldn't reach the local model". `ChatRequest.tools` passes tools for one step (Ask's `remember`). It builds every model in a role's chain up front.
- Every new model call goes through `AiSdkLlm`, with an `action` name (used for per-action overrides and metrics) and a prompt file in `core/prompts/`.

## Data

`%APPDATA%\Glossly` (`productName: "Glossly"`): `glossly.db`, `keys\<provider>.bin` (`safeStorage`; the encryption key lives in the profile's `Local State`), `models\` (embedding model), `logs\main.log`.

- **Schema migrations** (`store/migrations.ts`, tracked with `PRAGMA user_version`): 1 every spec table plus `meta`, `settings`, `models`; 2 `commitments.notified_at` and indexes; 3 voice-sample channel/person/draft columns, `style_signals`, `style_notes`, deleting unedited inserts; 4 `people.relationship` and "chat" → "messaging"; 5 `calendar_events` and `calendar_event_people` (decision 37). Never edit a shipped migration; add a new one.
- **Settings migrations** (`SETTINGS_MIGRATIONS` in `settings.ts`, applied by `Store.migrateSettings()`, count in meta `settings_migrations`): one-time changes to stored values when a default changes (router 400 → 600 ms, `minWords` 3 → 0, title keys → plain names, `localOnly` → `privacy`). An entry with `from` reads that key, writes its own, and deletes `from` (a rename). Never edit a shipped entry.
- **Vectors**: `vec0` table with a cosine metric; `ensureVectorModel(model, dims)` recreates it and reports when everything needs re-embedding.
- **Item kinds**: `selection` (with an excerpt `ContextWindow`), `note` (from Ask), `chart` (from Visualize; text is the CSV).
- **Export** (`exportAll`): every table except vectors; never keys.

## Privacy rules in code

- Logs (`log.ts`) and metrics (`sanitizePayload`) carry codes, counts, and timings only, never selected text or keys. Site keys are not logged either.
- Password fields are refused by the helper for every read and copy command.
- The keyboard is never hooked (decision 3).
- Nothing leaves this computer under Local only: only a local model on a loopback address, or code (decisions 12 and 34).
