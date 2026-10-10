# Glossly status: Phases 0 and 1

Updated Oct 10, 2026. This covers the first handoff (spec: Phases 0 and 1). `docs/HANDOFF.md` has the detailed build notes.

## Summary

All the code for Phases 0 and 1 is written and works end to end on this machine. You can select text and get the pill, or press the hotkey to get the bar. Ask streams an answer from Groq, Save stores the item with an embedding and entities and can be undone, and first-run setup and every settings tab work with your real key. `pnpm typecheck` is clean, and `pnpm test` passes 157 unit tests.

Phase 0 is not signed off yet, for two reasons:

- **The per-app capture checks and the toolbar-overlap checks haven't been run.** Only Notepad and Glossly's own settings window (Chromium) have been tested. These are hand tests for you, recorded in `evals/capture.md`.
- **Pill speed (reworked in Step 12.2, Oct 10).** It used to show in about 315 to 360 ms (a fixed 250 ms toolbar wait, then about 100 ms for `popups_near`). Now it checks for a selection toolbar from 100 ms after mouse-up and waits the full 250 ms only in apps known or learned to show one; elsewhere it shows after one check at about 100 ms. Live numbers: see "Selection to pill" below.

## How to run

```powershell
pnpm install
pnpm dev         # builds the C# helper, starts the app with hot reload
pnpm build       # production build into packages/shell-electron/out
pnpm test        # unit tests only
pnpm typecheck
pnpm eval        # router eval; the LLM half needs GROQ_API_KEY and takes about 3.5 minutes
```

The app lives in the tray. The default hotkey is `Ctrl+Alt+Space`. Data is in `%APPDATA%\Glossly` (`glossly.db`, encrypted keys in `keys\`, the embedding model in `models\`, and `logs\main.log`, which holds codes and timings only).

## Phase 0: capture works

| Spec check | Status | Notes |
| --- | --- | --- |
| Tray app, settings window, configurable hotkey, pnpm monorepo (`core`, `shell-electron`, `ui`) | Done | The hotkey recorder is built, but changing the hotkey hasn't been tried live. |
| C# helper with every protocol command and recorded fixtures | Done | Every command is in `helpers/protocol.md`, with fixtures in `helpers/fixtures/`. `pnpm helper:record --check` replays 10 cases against the live binary and all pass. |
| Auto pill: mouse hook, selection read, 3-word minimum, password-field skip, toolbar wait, toolbar-aware placement, non-focusable window | Done, except real toolbars | Verified in Notepad and in the settings window. The placement logic is unit tested, but `popups_near` hasn't been tried against a real app toolbar. The 250 ms wait now applies only where toolbars are expected (Step 12.2). |
| Hotkey path with copy fallback and clipboard restore | Done, partly verified | The helper's copy fallback restores the clipboard in hand tests (WPF and WinForms windows). In the app, the hotkey path has only run on apps that UIA can read, so the copy-fallback branch hasn't run live. |
| Debug view showing captured text, method, and tier-1 context | Done | Verified live. Also shows routing stage, fallback reason, and every timing. |
| Works in Chrome, Edge, Slack, Discord, Outlook web, VS Code, Notepad, recorded in `evals/capture.md` | Not done | Notepad passes, including tier 2. The table for the rest is ready for you to fill in. |
| No overlap with selection toolbars in Notion, Google Docs, Word, Slack's composer | Not done | Hand test, also in `evals/capture.md`. |
| Selection to pill under 150 ms | Reworked, not measured yet | Before Step 12.2: 314 and 358 ms in Notepad (250 ms wait, then about 100 ms for `popups_near`). Step 12.2 aims for about 150 ms where no toolbar is expected; the live numbers come with the Step 12 live check. |

## Phase 1: bar, Ask, Save

| Spec check | Status | Notes |
| --- | --- | --- |
| SQLite with migrations, collections, items, events | Done | Uses Node's built-in `node:sqlite` with `sqlite-vec` for vectors (decision 2). |
| Rules router plus `LlmStructuredDecision`; slots fill without moving buttons | Done | The bar is a fixed 560 px wide, so slots 3 and 4 fade in without shifting anything. Expanding a pill keeps Ask and Save in place. |
| Ask streams an answer | Done | Live: first token in 705 ms, done in 825 ms. Saved-note citations are built into the prompt but get no notes until Recall exists (Phase 3). |
| Save stores items with embeddings, entities, and undo | Done | Live: your two saved items have embeddings and four linked entities. Undo verified on the hotkey path. |
| Keyboard map from the Core user flow | Done | `1` to `4`, `Tab` (More in the bar, collections in Save), `Enter`, and `Esc` verified live in Notepad. `Ctrl+C` copying an Ask answer hasn't been tried live. |
| First-run setup and settings: keys with live test, model catalog, roles with fallbacks, hotkey, block list, local-only | Done | You ran setup yourself on Oct 10. All five tabs (Keys, Models, General, Data, Metrics) were checked with real data. |

Built ahead of schedule because the privacy rules require them from day one or the work was cheap: JSON export and "Delete all data" (Data tab), and the local metrics view (Metrics tab; spec Phase 4).

## Eval numbers

Router eval on the 60 hand-written fixtures in `fixtures/`. The spec's target is 85% type accuracy.

| Run | Type accuracy | Slot 3 and 4 match | Median time |
| --- | --- | --- | --- |
| Rules only (Oct 10) | 98.3% | 90.0% | under 1 ms |
| LLM, `groq:qwen/qwen3.8-27b` (Oct 9) | 100% | 61.7% | 247 ms, 3 of 60 calls over 400 ms |

The rules were tuned on these same fixtures, so expect lower numbers on real selections. The LLM's slot misses mostly came from counting chat speaker headers as "mentions people" (adding Who to 17 cases). The prompt was tightened afterwards but **not re-run** (Groq free-tier limits). Rules still miss automated mail (it gets Reply because the spec scores Reply as "written by someone else"), a message with first names only, one "please ... today" sentence read as a commitment, and one prose sentence with numbers just under the table threshold.

## Capture results per app

Pending your hand tests; see `evals/capture.md`. So far, Notepad passes on both paths (UIA read in about 55 to 60 ms, tier 2 in 50 to 93 ms), and the settings window passes on the auto path (UIA, 283 to 335 ms to the pill).

## Decisions that differ from the spec

1. **AI SDK v7 instead of v6.** v7 is current; the API changed (`instructions`, `Output.object`, `result.stream`).
2. **`node:sqlite` instead of `better-sqlite3`.** Built into Node and Electron, so there are no native rebuilds. Works with `sqlite-vec`.
3. **No `uiohook-napi`.** It installs a global keyboard hook, which the privacy rules forbid. The helper runs a mouse-only hook and learns that a key was pressed (never which one) from `GetLastInputInfo`, to hide the pill when you type.
4. **Evals run on Vitest** (`pnpm eval`), not `cargo test`.
5. **Embeddings:** local `all-MiniLM-L6-v2` (384 dimensions) through transformers.js, downloaded on first run with a notice in setup.
6. **pnpm** as the package manager.
7. **The router's decision call** takes `{ context, features, collections }` instead of the spec's `(input, questions)`, since the questions are fixed by the output format.
8. **Helper request arguments** are top-level JSON fields next to `cmd`.
9. **Tier 2 on the hotkey path uses a focus hand-off.** UIA reads the focused element, but the bar holds focus after the hotkey. On an action click, Glossly briefly gives focus back to your app, reads tier 2, and takes focus back. Tier 2 is still read only on action click.
10. **"Delete all data" is a full reset**: items, settings, and saved API keys all go, and setup runs again. Only the downloaded embedding model stays. (Open question below.)
11. **Setup's "Try it" step captures from the settings window itself**, only while that step is on screen. Every other Glossly window stays ignored.

Also: Groq retired its llama chat models, so the default roles are Fast = Qwen 3.8 (fallback gpt-oss-20b), Chat = gpt-oss-120b (fallback Qwen 3.8), and Decision = the Fast model. Free-tier limits are per model, so spreading roles across models also spreads the rate limits.

## Verified live and not verified

Verified on this machine (Windows 11, 125% scaling):

- Auto path in Notepad and the settings window: pill below the selection, hover to expand, click Ask or Save.
- Hotkey path in Notepad: UIA read, bar focused, the whole keyboard map, Save to a cycled collection with a why, then undo; `Esc` back to the bar, `Esc` again closes it and returns focus to Notepad.
- The tier-2 focus hand-off on both paths.
- The model router answering in 287 to 363 ms, with rules painting first; the rules fallback when no model is set up.
- Ask streaming with a real Groq key, and the "No chat model is set up" state with an "Add a key" button.
- First-run setup end to end: key test, model catalog, role defaults, Try it, Finish, then the embedding download and backfill.
- `pnpm dev` with hot reload in both windows (main-process edits need a restart).
- Fixes from the last two rounds: a second launch no longer runs a second copy of the app (it just opens Settings in the running one), `pnpm test` no longer runs the evals, settings Fast Refresh no longer falls back to a full reload, and the overlay no longer shows an Electron taskbar button when it takes focus (verified on the hotkey path).

Not verified live:

- Every app in the Phase 0 list except Notepad, and every toolbar-overlap check.
- `popups_near` against a real selection toolbar, so "move to the other side" has only been unit tested. The dot itself was checked live with `GLOSSLY_FORCE_DOT=1` (fake obstacles on both sides): it is a round 18 px mark at the end of the selection, clicks next to it go through to the app, and hovering it opens the bar.
- The copy-fallback branch inside the app.
- Changing the hotkey with the recorder, Export, "Delete all data" (destructive, so only reasoned through), and errors from refreshing the model catalog.
- `Ctrl+C` in the Ask panel.
- The forced-focus path for when Windows refuses to give the bar focus (it didn't trigger in the repro attempt).
- The taskbar fix on the auto path (it uses the same code as the hotkey path).
- The re-tuned router prompt (no eval re-run yet).
- Packaging: `pnpm dist` exists but there is no `electron-builder` config yet.

Known rough edges:

- Notepad's taskbar button flashes after the tier-2 hand-off on the hotkey path (Windows refusing one of the foreground changes). Harmless.
- The rules call the 39-word sample message in Notepad an `article`, because it has no speaker header.
- Ask's answer to a message assumes you wrote it. The Phase 2 "You" identity setup fixes that.

## Open questions for you

**Answered Oct 10** (the plan is in `docs/HANDOFF.md`, Steps 12 to 20):

- Pill speed: keep checking for toolbars but make it faster; a visible pill never moves.
- Router timeout: raise it to 600 ms.
- Delete all data: keep API keys and settings. A separate "Reset settings" button clears settings and keys.
- Local only: strict. Nothing goes to a cloud model, including entity extraction and Ask. Local model support comes later (Step 20).
- Packaging: after every Windows-buildable spec phase is done.
- Router eval: one run at the end, once everything looks good.
- New: the purple oval is the "dot" placement. Windows won't shrink the window below 29×38, which stretches the dot, and it shows too often because static toolbars count as obstacles. **Fixed in Step 12** (Oct 10): the dot is a fixed 18 px circle inside a 40×40 click-through window, and only obstacles that appeared after the selection's mouse-down count. Already-present ones (menu bars, app chrome, unrelated always-on-top windows), tooltips, windows behind the app, click-through overlays, and anything covering the selection are ignored. Every pill now records what it found (source, kind, size, side, why it was or wasn't counted) in the debug view, the `pill_shown` event, and `main.log` ("pill obstacles"). Before the fix, 8 of 120 pills were dots and 9 went above.
- New: a redesign with Windows 11 glass, monochrome, and a bar that fits its buttons (Step 13).
- Pill speed, **built in Step 12.2** (Oct 10). The pill checks for the app's own selection toolbar every 35 ms from 100 ms after mouse-up, and shows as soon as one is found (on the other side) or once the app's wait is over with none found. The wait is the full 250 ms in apps and sites known to show selection toolbars (Word, PowerPoint, Outlook, OneNote, Notion, Slack, Google Docs and Slides, Word and Outlook on the web, Medium) and 100 ms everywhere else. When a toolbar from the app itself shows up somewhere with the short wait (one extra check runs at 250 ms, after the pill is up), Glossly remembers that app or site and how soon the toolbar showed (setting `toolbarWaits`: a process name or site suffix plus a number of ms, no text) and waits that long there next time. A shown pill never moves. The check got cheaper too: the helper takes the mouse-down snapshot itself on a background thread, the window scan and the UIA probes run in parallel, the probes use a UIA cache request, there are 4 probes instead of 6, and process names no longer come from a full process list. The debug view has a "pill wait" line (when it was shown, the wait and why, the checks, and whether a toolbar was found), `pill_shown` records `wait_ms`, `wait_reason`, `polls`, and `popups_ms`, and `main.log` has a "pill shown" line per pill.

The original questions:

1. **Pill speed.** The pill took about 360 ms (250 ms toolbar wait plus `popups_near`) against the 150 ms target. Should it be faster and less careful about toolbars? One option is to show the pill at once and move it if a toolbar appears. (Answered; built in Step 12.2.)
2. **Router timeout.** The model router missed its 400 ms budget on 2 of 6 live calls (404 and 418 ms) and fell back to rules. Raise `router.decisionTimeoutMs` to about 600 ms, or accept rules as the frequent fallback?
3. **"Delete all data".** It currently also removes saved API keys and resets settings. Is that what you want, or should keys and preferences survive it?
4. **Local only.** It currently turns off only the router's model call, as the spec says. Save's entity extraction still calls the Fast model because you clicked an action. Should Local only also skip that?
5. **Packaging.** The `electron-builder` config (helper output into `resources/helper`, `asarUnpack` for sqlite-vec and onnxruntime) isn't written. Do it before Phase 2, or when testers are lined up?
6. **Router eval.** Can I run `pnpm eval` once to score the tuned prompt? If it stays under the rules' 90% slot match, I'd suggest using the model only for content type and collection, and computing people and commitment scores from rules.
