# Glossly build handoff

Read this first, then `docs/Highlight-to-Action App Prototype Spec.md` (the spec). This handoff covers what is already set up, the decisions made so far (some deviate from the spec, with reasons), and what to build next.

## Scope

Build Phases 0 and 1 of the spec, then stop for review. Commit to `main` as each milestone chunk lands. At the end, write `STATUS.md` (spec: "Instructions for the coding agent", item 8).

Spec sections to read in full before coding: Core user flow (incl. Coexisting with app selection toolbars), Architecture and stack, Capture layer, Router and action bar, Actions (Ask and Save only for Phase 1), Data model, Model providers, Privacy and safety rules, Milestones (Phase 0 and 1), Instructions for the coding agent. People layer, Reply, Recall, Visualize are later phases; skim them only so the design stays compatible.

## Environment (verified)

- System Node: v24.21.0 via nvm-windows at `C:\Program Files\nodejs`. Cursor's agent shell puts its own bundled Node 22 first on PATH, so prefix commands with `$env:PATH = "C:\Program Files\nodejs;" + $env:PATH;`.
- pnpm 12.10.1 (via corepack). pnpm 12 uses `allowBuilds` in `pnpm-workspace.yaml`, not `onlyBuiltDependencies`.
- .NET SDK 10.0.401 and Windows Desktop runtime 10.0.12. Visual Studio 2026 Community is installed.
- The agent shell often returns empty output; requesting `all` permissions fixes it.

## What exists

```
package.json            root scripts: dev, build, dist, helper:build, helper:publish, helper:record, test, eval, typecheck
                        postinstall downloads the Electron binary (Electron 44 no longer does this itself)
pnpm-workspace.yaml     packages/*, nodeLinker: hoisted (for electron-builder), allowBuilds
tsconfig.base.json      strict, module preserve, moduleResolution bundler, noEmit
vitest.config.ts        projects: "unit" (packages/*/src/**/*.test.ts) and "evals" (evals/**/*.eval.ts)
packages/core/          package.json + tsconfig only. Exports ./src/index.ts, ./embed, ./api (files not written yet)
packages/ui/            package.json + tsconfig only (React 19)
packages/shell-electron/ package.json + tsconfig only (electron-vite; renderer root should point at ../ui)
helpers/windows/        C# helper, partially written (see below)
```

Pinned versions (all checked for compatibility): electron 44.7.0 (Node 24.21 inside), electron-vite 5.0.0, vite 7.3.7 (electron-vite 5 does not support Vite 8), @vitejs/plugin-react 5.2.0, react 19.3, typescript 7.0.2, ai 7.0.137 with @ai-sdk/groq, openai, anthropic v4, zod 4.6, sqlite-vec 0.1.9, @huggingface/transformers 4.3.1, uuidv7, vitest 5, electron-builder 26. FlaUI.UIA3 5.0.0 for the helper.

## Decisions made (deviations from the spec)

1. **AI SDK v7, not v6.** v7 is current. API notes: `instructions` replaces `system`; structured output is `generateText({ output: Output.object({ schema }) })` then `result.output`; streaming is `streamText(...).textStream`; ESM only; errors are `APICallError` with `statusCode`. Docs ship in `node_modules/ai/docs/` (see `08-migration-guides/23-migration-guide-7-0.mdx`). Provider factories: `createGroq`, `createOpenAI`, `createAnthropic` with `{ apiKey }`. The SDK also has `Experimental_DecisionModelV4`, which is relevant to Phase 4 decision providers.
2. **`node:sqlite` instead of `better-sqlite3`.** Verified inside Electron 44: `new DatabaseSync(path, { allowExtension: true })`, `db.loadExtension(require('sqlite-vec').getLoadablePath())`, and a `vec0` table with a KNN query all work. No native module or ABI rebuilds, and the same code runs in Vitest on Node 24. Pass vectors as `new Uint8Array(new Float32Array(v).buffer)`.
3. **No `uiohook-napi`.** It installs a global keyboard hook along with the mouse hook, which breaks the privacy rule "the only global keyboard hook is the hotkey". Instead, the C# helper runs a mouse-only `WH_MOUSE_LL` hook and pushes events over stdout. "Hide pill when the user types" uses `GetLastInputInfo`: input activity that the mouse hook didn't see counts as keyboard activity, so the app never sees which keys were pressed. The mouse-moved-200px check is done in Electron by polling `screen.getCursorScreenPoint()` while the pill is visible.
4. **Evals use Vitest** (`pnpm eval`), not `cargo test`.
5. **Embeddings:** local `Xenova/all-MiniLM-L6-v2` (384 dims) through transformers.js in an Electron utility process. The app downloads it on first run into the app data dir, with a notice in first-run setup (Rayan chose this for ease of use).
6. **Package manager:** pnpm, as the spec says. Rayan is more used to npm, so keep the instructions simple.

## C# helper status (`helpers/windows/`)

Done: `GlosslyHelper.csproj` (net10.0-windows, assembly `glossly-helper`), `app.manifest` (PerMonitorV2 DPI, so all coordinates are physical pixels and Electron converts with `screen.screenToDipRect`), `Win32.cs` (all P/Invokes needed), `Input.cs` (SendInput, `ReleaseModifiers` waits for or releases the held hotkey keys with a dummy-key trick so Alt doesn't open menus, `Chord`, `TapDummyKey`), and `ClipboardOps.cs` (full-format snapshot and restore in `finally`, `CopySelection(timeoutMs)` polls `GetClipboardSequenceNumber`, `PasteText` sets text with formats that keep it out of Win+V history, waits about 250 ms, then restores). Both clipboard methods run on an STA thread.

Not done yet (references `HelperException(code, message)`, which still needs defining):

- `MouseHook.cs`: LL mouse hook on its own thread with a `GetMessage` loop. Emit `{"event":"mouse_down"}`, `{"event":"mouse_up","x","y","drag":bool,"double":bool}` (drag means more than 4 px from mouse-down; double means a second up within `GetDoubleClickTime` and within 4 px), and `{"event":"wheel"}`. Add `input_watch` on/off: while on, poll `GetLastInputInfo` every 50 ms and emit `{"event":"keyboard_activity"}` when the input tick moves without a matching mouse event. Ignore injected events that carry `Input.Signature`.
- `Uia.cs` (FlaUI UIA3, MTA thread, set `ConnectionTimeout` and `TransactionTimeout` to about 1 s):
  - `selection`: focused element, walking up to the nearest TextPattern provider; fall back to `FromPoint(cursor)`. Use `GetSelection()[0]`, with bounds from the union of `GetBoundingRectangles()`. `is_password` comes from `IsPassword`. `is_editable` means an Edit control type or a ValuePattern that isn't read-only. For Chromium windows (class `Chrome_WidgetWin_*`), first send `WM_GETOBJECT` via `SendMessageTimeout` to nudge accessibility on.
  - `context {before, after}`: clone the range, collapse it, then `MoveEndpointByUnit` by characters.
  - `context_container {max_chars}`: walk up from `GetEnclosingElement()` to the nearest Document, List, or Pane, and use `docPattern.RangeFromChild(ancestor)` text centered on the selection. Fall back to tier 1.
  - `popups_near {bounds, exclude_pids}`: `EnumWindows` for visible, non-cloaked popup, tool, or topmost windows near the bounds, plus UIA hit-test points above and below the selection looking for ToolBar, Menu, or ToolTip ancestors. Budget about 80 ms.
- `Focus.cs`: `restore_focus {handle}` restores the window if minimized, then `SetForegroundWindow`; if that fails, use the `AttachThreadInput` trick plus `TapDummyKey`, and verify it worked.
- `Program.cs`: reads JSON lines from stdin, one at a time, and writes one response line per request: `{id, ok, result}` or `{id, ok:false, error:{code,message}}`. Unsolicited events have no `id`. Writes to stdout are locked. Commands: `ping`, `selection`, `context`, `context_container`, `foreground` (process name, title, handle, pid, class), `popups_near`, `copy_fallback {timeout_ms=120}`, `restore_focus`, `paste {text}`, `mouse_hook {enabled}`, `input_watch {enabled}`. Never log selection text.
- `helpers/protocol.md`: document every command and event above. Add protocol fixtures in `helpers/fixtures/` as request and response JSON, validated by Zod schemas in core so the macOS helper can be checked against the same cases. `scripts/record-helper.mjs` (`pnpm helper:record`) runs the commands against the foreground app after a 3 s delay and saves the result.

Then run `pnpm helper:build` and smoke test it by piping `{"id":1,"cmd":"ping"}` in.

## Next steps, in order

1. Finish the helper (above), build it, and smoke test it.
2. **Core** (`packages/core/src`, no Electron imports):
   - `types.ts`: SelectionPayload, as in the spec.
   - `api.ts`: the typed IPC API shared by the shell and the UI.
   - `helper/`: protocol Zod schemas, plus a `HelperClient` over any stdin/stdout pair, with timeouts and an event emitter.
   - `capture/`: gating (3-word minimum, password, per-app mode matched by process name or window-title suffix such as "- Google Docs", default hotkey-only list, block list with password managers) and pill placement (opposite side if a toolbar is detected, a 12 px dot if both sides are taken).
   - `router/`: features (under 5 ms), `RulesDecision`, `LlmStructuredDecision` with a 400 ms timeout that falls back to rules, and slot assignment with thresholds from settings.
   - `store/`: `node:sqlite` with migrations covering all spec tables plus `meta`, `models`, `settings`, and `item_vectors`; export and delete-all.
   - `llm/`: AI SDK provider registry, model-list fetch per provider, `models/capabilities.json` (patterns, never-auto-assign "Untested"), roles with defaults and fallback-on-429/5xx, and structured calls with one retry that includes the validation error.
   - `actions/`: Ask (streaming, default question "Explain this briefly.") and Save (excerpt, embedding, entity extraction, 10 s undo).
   - `metrics.ts`, and `prompts/*.md` loaded with `?raw`.
3. **Core tests and fixtures:** `fixtures/*.json` (spec asks for 60 across categories), a router eval in `evals/`, and a fixture plus test for every model-backed function and helper command.
4. **Shell** (`packages/shell-electron`, electron-vite):
   - Tray, plus overlay windows created once at launch (`focusable:false`, `showInactive`, always on top, skip taskbar; `setFocusable(true)` only on the hotkey path or when an action needs typing).
   - `globalShortcut` hotkey (`Ctrl+Alt+Space`, configurable).
   - Helper manager (spawn `helpers/windows/bin/Debug/net10.0-windows/glossly-helper.exe` in dev, `resources/` when packaged; auto-restart).
   - Auto pill path with the 250 ms delay, and hotkey path with `copy_fallback`.
   - `safeStorage` keys file; embeddings utility process; IPC with `contextIsolation` on.
5. **UI** (`packages/ui`, React):
   - Pill → bar (fixed slots that fade in, badges, debug view with captured text, method, and tier-1 context), plus panel (Ask stream, Save with collection `Tab`-cycling, the "why" field, and undo).
   - Keyboard map.
   - First-run setup (Welcome, Keys with live test and Groq first, Models/roles, Try it) and Settings (Keys, Models, General: hotkey, local-only, per-app modes, block list; Data: export, delete all; Metrics table).
6. **Verify:** `pnpm typecheck`, `pnpm test`, `pnpm dev`. Then write `STATUS.md` and `evals/capture.md` (per-app pass/fail table for Rayan to fill in by hand: Chrome, Edge, Slack, Discord, Outlook web, VS Code, Notepad; plus toolbar overlap in Notion, Google Docs, Word, and Slack's composer). Commit.

## Things Rayan has to do himself

- Get a Groq API key (free) for testing model calls.
- Hand-test capture across the listed apps and record the results in `evals/capture.md`.
