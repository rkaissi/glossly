# Glossly build handoff

Read this first, then `docs/Highlight-to-Action App Prototype Spec.md` (the spec) for general context. This file is the current source of truth: what exists, decisions that deviate from the spec, and what to build next.

## Scope

Build Phases 0 and 1 of the spec, then stop for review. Commit to `main` as each milestone chunk lands. At the end, write `STATUS.md` (spec: "Instructions for the coding agent", item 8).

Spec sections that matter for this scope: Core user flow (incl. Coexisting with app selection toolbars), Architecture and stack, Capture layer, Router and action bar, Actions (Ask and Save only for Phase 1), Data model, Model providers, Privacy and safety rules, Milestones (Phase 0 and 1). People layer, Reply, Recall, and Visualize are later phases; keep the design compatible with them but don't build them.

## Environment (verified)

- System Node: v24.21.0 via nvm-windows at `C:\Program Files\nodejs`. Cursor's agent shell puts its own bundled Node 22 first on PATH, so prefix commands with `$env:PATH = "C:\Program Files\nodejs;" + $env:PATH;`.
- pnpm 12.10.1 (via corepack). pnpm 12 uses `allowBuilds` in `pnpm-workspace.yaml`, not `onlyBuiltDependencies`. Use `pnpm exec vitest ...` rather than `npx` (npx prints npm warnings).
- .NET SDK 10.0.401 and Windows Desktop runtime 10.0.12. Visual Studio 2026 Community is installed.
- The agent shell often returns empty output; requesting `all` permissions fixes it. PowerShell shows stderr lines from pnpm as red "NativeCommandError" text even when the command succeeds, so check `$LASTEXITCODE`.
- The display is at 125% scaling, so the helper's physical-pixel coordinates are 1.25 × DIP.

## Pinned versions (all checked for compatibility)

electron 44.7.0 (Node 24.21 inside), electron-vite 5.0.0, vite 7.3.7 (electron-vite 5 does not support Vite 8), @vitejs/plugin-react 5.2.0, react 19.3, typescript 7.0.2, ai 7.0.137 with @ai-sdk/groq 4.0.59, @ai-sdk/openai 4.0.91, @ai-sdk/anthropic 4.0.78, zod 4.6.5, sqlite-vec 0.1.9, @huggingface/transformers 4.3.1, uuidv7 1.2.1, vitest 5.0.3, electron-builder 26.15.3. FlaUI.UIA3 5.0.0 for the helper.

## Decisions made (deviations from the spec)

1. **AI SDK v7, not v6.** API notes: `instructions` replaces `system`; structured output is `generateText({ output: Output.object({ schema }) })` then `result.output`; full stream is `result.stream` (was `fullStream`), with `text-delta` parts carrying `.text` plus `error` and `abort` parts; ESM only; errors are `APICallError` (`statusCode`), `RetryError` (`lastError`), `NoObjectGeneratedError`, `StreamProviderError`. Docs ship in `node_modules/ai/docs/` (see `08-migration-guides/23-migration-guide-7-0.mdx`). Test mocks: `MockLanguageModelV4` from `ai/test` (constructor takes `doGenerate` / `doStream` results; result shape in `@ai-sdk/provider` `LanguageModelV4GenerateResult`: `content`, `finishReason: {unified, raw}`, `usage: {inputTokens:{total,...}, outputTokens:{total,...}}`, `warnings`).
2. **`node:sqlite` instead of `better-sqlite3`.** `new DatabaseSync(path, { allowExtension: true })` plus `db.loadExtension(require('sqlite-vec').getLoadablePath())`. Works in Vitest on Node 24 (tested) and inside Electron 44 (verified earlier). No native rebuilds. When packaging, sqlite-vec's DLL must be `asarUnpack`ed.
3. **No `uiohook-napi`.** It also installs a global keyboard hook, which breaks the privacy rule. The C# helper runs a mouse-only `WH_MOUSE_LL` hook and reports keyboard activity through `GetLastInputInfo` (it never sees which keys). The "mouse moved 200 px away" check is done in Electron by polling `screen.getCursorScreenPoint()` while the pill is visible.
4. **Evals use Vitest** (`pnpm eval`), not `cargo test`.
5. **Embeddings:** local `Xenova/all-MiniLM-L6-v2` (384 dims) through transformers.js in an Electron utility process, downloaded on first run into the app data dir, with a notice in first-run setup.
6. **Package manager:** pnpm. Rayan is more used to npm, so keep instructions simple.
7. **`DecisionProvider.decide(input, signal)`** takes `{ context, features, collections }` instead of the spec's `(input, questions)`; the questions are fixed by our output contract.
8. **Helper request arguments are top-level fields** next to `cmd` (e.g. `{"id":3,"cmd":"context","before":500,"after":500}`).

## Done

### Step 1: C# helper (complete, committed `ac6510a`)

`helpers/windows/`: `Program.cs` (JSON-lines loop, one request at a time on the MTA main thread, exits on stdin EOF, emits a `ready` event), `Output.cs` (single queued stdout writer thread so the hook callback never blocks), `HelperException.cs`, `MouseHook.cs`, `Uia.cs`, `Focus.cs`, plus the earlier `Win32.cs`, `Input.cs` (now records `LastInjectedTick`), and `ClipboardOps.cs`.

- `helpers/protocol.md` documents every command, error code, and event. Read it before touching the shell's helper code.
- `helpers/fixtures/*.json` (one file per command, plus `errors.json` and `events.json`) are validated by `packages/core/src/helper/protocol.test.ts`.
- `pnpm helper:record` (`scripts/record-helper.mjs`) records read-only commands against the foreground app after 3 s (`--copy` adds `copy_fallback`) into git-ignored `helpers/fixtures/recorded/local-*.json`. `pnpm helper:record --check` replays the 10 deterministic fixture cases against the live binary; all pass.
- Hand-tested with throwaway WPF and WinForms windows. Working: `selection` (text, bounds, editable, control type), `context`, `context_container` (centered, clipped to container), password fields return empty text and the context and copy commands refuse, `copy_fallback` and `paste` both restore the original clipboard, and `restore_focus` reports `window_gone`. Mouse hook: click, drag, and double-click are classified correctly, mouse movement causes no false `keyboard_activity`, and a real key does trigger it.
- Findings: WinForms (.NET Framework) text boxes expose no TextPattern, so those apps need the hotkey's copy fallback. WPF counts `\r\n` as one character unit (handled). The first `selection` call per Chromium window costs about 300 ms (accessibility nudge plus one retry); later calls are fast. `restore_focus` success paths and `popups_near` against real toolbars have not been tested yet; that happens during the per-app hand tests.

### Step 2: Core (mostly done, committed `c9f7adc`)

All under `packages/core/`. Imports are extensionless (bundler resolution). Prompts are loaded with `?raw` (`src/env.d.ts` declares `*.md?raw`). 58 unit tests pass and `tsc` is clean.

- `src/types.ts`: `Rect`, `Point`, `SelectionPayload` (as in the spec), `ContainerContext`, `Collection`, `Item`, and `isoNow()` (ISO 8601 with offset).
- `src/settings.ts`: Zod `SettingsSchema` with defaults for everything tunable: hotkey `Control+Alt+Space`, `localOnly`, `debugView`, `appModes`, `blockList`, `capture` (minWords 3, pillDelayMs 250, hideDistancePx 200, contextChars 500, containerChars 8000, copyTimeoutMs 120), `router` (slot 0.5, more 0.2, decisionTimeoutMs 400), `roles` (fast, chat, decision; each `{model, fallback, manual}`, where model refs look like `"groq:llama-3.1-8b-instant"`; a decision model of null means "Use Fast model"), `actionModels` (per-action override), `save` (undo 10 s, excerpt 1000), `ask.defaultQuestion`, `embeddings`, `pendingNotice`, `firstRunComplete`. It also exports `DEFAULT_COLLECTIONS` and `parseSettings()`, which keeps valid keys and defaults bad ones.
- `src/helper/protocol.ts`: Zod schemas per command (`Commands[cmd].args/result`), plus `ResponseSchema` and `EventSchema`. `src/helper/client.ts`: `HelperClient(stdin, stdout, timeouts?)` with a typed `request(cmd, args)`, per-command timeouts, result validation, and `HelperError` (`code` is a protocol code or `timeout`, `closed`, or `invalid_response`). It emits `event`, `ready`, `close`, and `protocol_error`.
- `src/capture/apps.ts`: `DEFAULT_BLOCK_LIST` (password managers plus web-vault title suffixes), `DEFAULT_HOTKEY_ONLY` (excel, Google Sheets, terminals, mstsc), `stripBrowserSuffix`, `keyMatches` (process name, or a title suffix when the key starts with "-"), `siteKeyFor` (the key "Don't show here" should store), and `resolveAppMode` (block list, then user modes with site keys first, then defaults). `src/capture/gating.ts`: `countWords` (`Intl.Segmenter`), `gateApp`, `gateAutoSelection`, `mayCopyFallback`. `src/capture/placement.ts`: `placePill` places below by default, above if blocked, and as a 12 px dot if both sides are taken; `placeBar` never becomes a dot.
- `src/router/`: `types.ts` (Decisions Zod contract, `SelectionContext`, `DecisionProvider`, `CONTEXTUAL_ACTIONS` = reply/who/promises/visualize, `Slots`), `features.ts` (`extractFeatures`), `rules.ts` (`RulesDecision`, `decideByRules`, `ruleCollection`), `slots.ts` (`scoreActions`, `assignSlots`), `llm-decision.ts` (`LlmStructuredDecision`, which uses role `decision`; prompt in `prompts/router-decision.md`), and `router.ts` (`Router` with `quick()` for rules-only instant paint, and `route()`, which races the decision against `decisionTimeoutMs`, aborts on timeout, falls back to rules, and returns a `fallback` reason of `local_only`, `no_model`, `timeout`, or `error`).
- `src/store/`: `migrations.ts` (v1: every spec table plus `meta`, `settings`, `models`; tracked via `PRAGMA user_version`) and `store.ts` (`Store(path, { vecExtensionPath })`). The Store covers meta, settings, collections (seeds the defaults), items (`deleteItem` cascades links, the vector, and orphan entities), entities (`upsertEntity` matches on canonical form, `linkItemEntity`), and vectors (`ensureVectorModel(model, dims)` recreates the `vec0` table with a cosine metric and returns true when everything needs re-embedding; `setVector`, `searchVectors` returns a similarity, `itemsWithoutVectors`). It also covers events, the model catalog (`replaceModels`, `removeProviderModels`, `listModels`), `exportAll()` (all tables except vectors; no keys), and `deleteAll()` (re-seeds collections).
- `src/llm/`: `types.ts` (`ChatRequest {role, action?, instructions, prompt, signal?, ...}`, `LlmProvider {stream, structured, hasModel}`, `LlmError`). `models/capabilities.json` holds the exclude patterns, known-model patterns (structured mode `json_schema`, `json`, or `none`, plus cost, speed, and tier), and role preferences. `catalog.ts` has `isChatModel`, `lookupCapabilities`, `toCatalogModel`, `pickDefault('fast'|'chat')` (untested models are never auto-picked), and `toRef`/`parseRef`. `providers.ts` defines `PROVIDERS.groq/openai/anthropic`: `createModel`, and `listModels`, which doubles as the live key test and throws `ProviderKeyError` with the provider's message. `roles.ts` has `updateRoles(roles, models)`, which fills defaults, auto-picks a fallback from a different provider, never overwrites a manual pick that is still available, and emits notices; and `modelChain(role, settings, action)`. `llm.ts` has `AiSdkLlm`: it streams via `result.stream`, falls back on 429 or 5xx only before the first token, and makes structured calls with one retry that appends the validation error. In JSON mode (Groq llama models) it puts the JSON Schema into the instructions and sets `groq.structuredOutputs: false`. It also exports `isFallbackError`.
- `src/embed/types.ts` (`Embedder`, `EmbedProgress`) and `src/embed/transformers.ts` (`createTransformersEmbedder({model, dims, cacheDir, onProgress})`, mean pooling, normalized). Not run yet; the model has never been downloaded.
- Prompts written: `prompts/router-decision.md`, `prompts/ask.md`, `prompts/extract-entities.md`.

### Step 3: Finish core (complete)

75 unit tests pass; core `tsc` is clean (`pnpm typecheck` fails only on `packages/ui`, which has no sources yet).

- `src/actions/context.ts`: `contextWindow(selection, container, maxChars)` returns the selection with surrounding text (tier 2 if read, else tier 1), centered and shifted when one side runs out, plus the selection's offset inside it. Used by Ask (prompt context) and Save (the stored excerpt).
- `src/actions/ask.ts`: `buildAskPrompt` (sections: Question, Selection with app and title, Surrounding context with a `[SELECTION]` marker in place of the selection, Saved notes as `<note label="From your note, Sep 18">`, deduplicated as "(2)" on the same date, max 3 notes), and `ask(llm, settings, input, signal)`, which streams on role `chat`, action `ask`.
- `src/actions/save.ts`: `SaveService({store, llm, embedder: () => Embedder | null, settings, metrics?, now?})`. `save()` resolves the collection by name (creates it if missing), inserts at once, and returns `{item, undoUntil, enriched}`; `enriched` is a never-rejecting promise for tests and the shell. `data_json` is `SelectionItemData` (`excerpt` is a `ContextWindow`). Enrichment embeds `text` plus `why`, then extracts entities on role `fast`, action `save_entities` (skipped when `hasModel('fast')` is false). A matched person's existing entity is reused, otherwise the new entity is set as `people.entity_id`. `undo()` works until `undoUntil` plus 1.5 s, aborts enrichment, and leaves no vector or entities behind. `setWhy()` re-embeds after enrichment. `idle()` waits for all background work. Errors go to `save_enrich_error` with only `{stage, code}`. With no embedder (model not downloaded) items stay in `itemsWithoutVectors()` for a later backfill.
- Store gained `listKnownPeople()` (feeds `RouterDeps.people`), `findPersonByName()` (canonical name or name alias), and `setPersonEntity()`.
- `src/metrics.ts`: `Metrics(store, now?)`, `sanitizePayload`, `record()` never throws. `summary(days)` returns per-day counts, totals, `expand_rate` (bar_shown with `trigger: 'auto'` divided by pill_shown), and per action `{clicks, click_rate, median_ms}`. Click rate is clicks divided by triggers (hotkey plus pill_shown). The shell must record `action_clicked` with `{action, ms}` (ms since trigger) and `bar_shown` with `{trigger}`.
- `src/api.ts`: `OverlayState` (session id, mode hidden/pill/dot/bar/panel, placement, keyboard flag, `hasSelection`, `siteKey`, `debug`, `SlotsView` with routing stage and fallback reason, badges, open panel, notice), `InvokeChannels` and `PushChannels` maps, and `GlosslyBridge` (what the preload exposes as `window.glossly`: typed `invoke(channel, args)` and `on(channel, cb)`). Main owns the selection; renderers refer to it by `sessionId` and never send text back, except `clipboard:write` for Ctrl+C in a panel.
- `src/index.ts`: re-exports everything except the transformers embedder; the API types are re-exported with `export type *`.

### Step 4: Core tests, fixtures, router eval (complete)

111 unit tests pass. `src/router/router.test.ts` covers features, rules, slots, router fallbacks (timeout with abort, error, no_model, local_only), and `LlmStructuredDecision`. `src/llm/llm.test.ts` covers `AiSdkLlm` with `MockLanguageModelV4` (429 fallback before the first token, none after it, none on 401, `no_model`, native schema mode, the retry with the validation error, the Groq JSON-mode path, the decision role using Fast), plus `isFallbackError`, the catalog, roles, and `providers.listModels` with a fake fetch. Note that `AiSdkLlm` builds every model in a role's chain up front, so test mocks need all of them.

- `fixtures/{messages,commitments,tables,articles,code,contacts}.json`: 60 cases, `{id, context: SelectionContext, expected: {content_type, slots}}`. `slots` is the ideal set for slots 3 and 4, order ignored.
- `evals/router.eval.ts` writes `evals/results/router-{rules,llm}.json`; `evals/print-results.mjs` prints the summary and a table of misses. The LLM run needs `GROQ_API_KEY` (model `groq:llama-3.1-8b-instant`, override with `GLOSSLY_EVAL_MODEL`) and reports errors and calls over 400 ms. It has not been run yet.
- The first rules run scored 78.3% type accuracy. These heuristics changed: code keywords count only on lines with code punctuation (plus Python block openers); articles need 35 or more words and 2 or more sentences (was 60 words); name pairs skip chat speaker headers and greeting words, and count 0.3 instead of 0.55 in articles, tables, and code; numeric tokens accept unit suffixes (42ms, 12.1k). Rules-only is now at **98.3% type accuracy and 90% slot match**. The tuning used the same fixtures it is scored on, so expect lower numbers on real selections; Rayan's real examples are the real test.
- Remaining misses: automated mail (shipping notice, all-staff notice, one-time passcode) gets Reply, because the spec scores Reply as `authored_by_other`, which is true for automated mail too. That is a scoring gap for Phase 2 Reply, not a rules bug. Also msg-16 (single first names, so no Who), msg-18 ("please" plus "today" reads as a commitment), and tbl-04 (a prose sentence with 26% numeric tokens, under the spec's 30% threshold).

## Next steps, in order

1. ~~Finish core~~ (done, see Step 3 above).
2. ~~Core tests and fixtures~~ (done, see Step 4 above).
3. **Shell** (`packages/shell-electron`, electron-vite; renderer root should point at `../ui`; no `electron.vite.config.ts` exists yet):
   - Tray, plus overlay windows created once at launch (`focusable:false`, `showInactive`, always on top, skip taskbar; call `setFocusable(true)` only on the hotkey path or when an action needs typing).
   - `globalShortcut` hotkey (configurable).
   - Helper manager: spawn `helpers/windows/bin/Debug/net10.0-windows/glossly-helper.exe` in dev, or from `resources/` when packaged; wrap it in `HelperClient`; restart it automatically and re-send `mouse_hook` on `ready`. Convert physical pixels with `screen.screenToDipRect`.
   - Auto pill path: `mouse_up` with drag or double, then `foreground` and `gateApp`, then `selection` and `gateAutoSelection`, then wait out the rest of the 250 ms, then `popups_near` (exclude Electron's own pids), then `placePill`, then show. While the pill is visible, enable `input_watch` and hide on `keyboard_activity`, `wheel`, a `mouse_down` outside the pill, or the cursor moving more than 200 px away.
   - Hotkey path: `foreground`, then `selection`, then `copy_fallback` if `mayCopyFallback`, then `context`. Open the bar focused. If nothing was found, show the "nothing selected" state.
   - Expand: tier-1 `context`, then `Router.quick` to paint, then `Router.route` to fill slots 3 and 4.
   - Keys: one `safeStorage`-encrypted file per provider in userData. Embeddings run in a `utilityProcess` using `@glossly/core/embed`. Store at `userData/glossly.db`. IPC uses `contextIsolation` with a preload `contextBridge`.
4. **UI** (`packages/ui`, React):
   - Pill and bar: fixed slots that fade in, badges, and a debug view showing captured text, method, and tier-1 context. Panel: Ask stream; Save with `Tab` cycling through collections, the "why" field, and undo. Later-phase actions in slots 3 and 4 show a "Coming in a later phase" panel.
   - Keyboard map per the spec.
   - First-run setup: Welcome (privacy summary plus the embedding-download notice), Keys (live test, Groq first and labeled free), Models and roles, Try it.
   - Settings tabs: Keys; Models; General (hotkey, local-only, per-app modes, block list); Data (export, delete all); Metrics table.
5. **Verify:** run `pnpm typecheck`, `pnpm test`, and `pnpm dev`. Then write `STATUS.md` and `evals/capture.md`, a per-app pass/fail table for Rayan to fill in by hand (Chrome, Edge, Slack, Discord, Outlook web, VS Code, Notepad, with columns for whether selection and tier-2 context work, plus toolbar overlap in Notion, Google Docs, Word, and Slack's composer). Commit.

## Open question for Rayan (note in STATUS.md)

"Local only" currently means only the router's model call is disabled, as the spec says. Save's entity extraction (Fast model) still runs because the user clicked an action. Should local-only also skip it?

## Things Rayan has to do himself

- Get a Groq API key (free) for testing model calls.
- Hand-test capture across the listed apps and record the results in `evals/capture.md`.
