# Testing

Three kinds of checks: unit tests (fast, run on every change), evals (call real models, run rarely), and live checks (the real app on Rayan's desktop, run through a subagent). The live-check backlog at the end is everything built but not yet seen working in the app.

## Unit tests

```powershell
pnpm test        # vitest run --project unit: packages/*/src/**/*.test.ts (547 tests on Oct 11)
pnpm typecheck   # tsc in all three packages
```

- `pnpm test` never runs evals (they are a separate Vitest project, even when `GROQ_API_KEY` is set).
- Model mocks: `MockLanguageModelV4` from `ai/test`; its constructor takes `doGenerate`/`doStream` results shaped like `@ai-sdk/provider`'s `LanguageModelV4GenerateResult` (`content`, `finishReason: {unified, raw}`, `usage: {inputTokens:{total,...}, outputTokens:{total,...}}`, `warnings`). `AiSdkLlm` builds every model in a role's chain up front, so mocks need all of them.
- Store tests use a temp `node:sqlite` file with sqlite-vec loaded (works on Node 24).
- Helper protocol: `helpers/fixtures/*.json` (one file per command, plus `errors.json` and `events.json`) are validated by `packages/core/src/helper/protocol.test.ts`. Update the fixture when a command changes.
- **Helper against the live binary:** `pnpm helper:record --check` replays the deterministic fixture cases. `pnpm helper:record` (`--copy` adds `copy_fallback`) records read-only commands against the foreground app after 3 s into git-ignored `helpers/fixtures/recorded/local-*.json`. `context_caret` reads screen state, so it has no `--check` case.
- Test data uses fictional people only (AGENTS.md).

## Evals

Don't run these unless Rayan asks: they call Groq, whose free tier allows 1,000 requests per day and 8,000 tokens per minute per model.

```powershell
pnpm eval   # vitest run --project evals, then evals/print-results.mjs
```

- **Router eval** (`evals/router.eval.ts`, 60 hand-written cases in `fixtures/{messages,commitments,tables,articles,code,contacts}.json`, each `{id, context, expected: {content_type, slots}}`). Rules run offline; the LLM run needs `GROQ_API_KEY` (model `groq:qwen/qwen3.8-27b`, override with `GLOSSLY_EVAL_MODEL`), waits and retries on 429 (about 3.5 minutes for 60 cases), and fails if more than 10% of calls error. Results go to git-ignored `evals/results/router-{rules,llm}.json`; `print-results.mjs` prints the summary, distinct errors, and misses.
- **Comparison evals** (only with `GROQ_API_KEY` and `GLOSSLY_COMPARE=1`; helpers in `evals/lib.ts`, old code and prompts in `evals/legacy/`; calls paced by `GLOSSLY_COMPARE_GAP_MS`, default 2.5 s; about 300 calls for both):
  - `evals/visualize-compare.eval.ts`: model-written Vega-Lite against the structured chart pick, 20 cases in `fixtures/visualize/charts.json`; renders both and writes JSON plus a side-by-side HTML page to `evals/results/`.
  - `evals/router-collection-compare.eval.ts`: string collection with a code fix-up against the enum, 60 fixtures, Qwen 3.8 and gpt-oss-20b (`GLOSSLY_COMPARE_MODELS`).

### Results so far

| Run | Type accuracy | Slot 3/4 match | Notes |
| --- | --- | --- | --- |
| Rules only (Oct 10) | 98.3% | 90.0% | Tuned on these same fixtures, so expect lower on real selections. |
| LLM, Qwen 3.8 (Oct 9) | 100% | 61.7% | Median 247 ms. Most slot misses: counting chat speaker headers as "mentions people" (Who added to 17 cases), low commitment scores on 6. |

- The router prompt was tightened after the Oct 9 run (speaker headers, commitments, automated mail, contact cards, collection by content) and its schema changed (`best_collection` enum, decision 22). **None of that has been re-scored.** Step 21 is that run.
- Remaining rules misses: msg-16 (first names only, so no Who), msg-18 ("please ... today" read as a commitment), tbl-04 (prose with 26% numeric tokens, under the 30% threshold). Automated mail no longer gets Reply (`reply-scoring.test.ts` checks all 60 fixtures offline).
- Visualize comparison (one partial run, Qwen 3.8, 13 cases where both answered): the old way gave a relevant chart on 7, the chart pick on 12. No HTML was written, so looks weren't compared. The router collection comparison has never run.
- Model latency on Groq (Oct 9, router call): Qwen 3.8 with reasoning off about 175 ms; gpt-oss-20b at low effort 320 to 550 ms; gpt-oss-120b 500 to 650 ms. Live router calls since: 287 to 446 ms.

## Live checks

### Before you drive the desktop

1. Rayan may be using the machine. Check `%APPDATA%\Glossly\logs\main.log` (recent activity), whether a Glossly instance is running, and the DB's row counts (items, entities, people, voice samples) so you can restore them.
2. If an instance is running and you need the new build, ask before stopping it. The helper exe can't be rebuilt while it runs.
3. Run the check through a subagent (AGENTS.md): Composer or Grok in Cursor; in Claude Code, a Sonnet subagent (Rayan's choice). Give it exact steps, what to check, and what to report (pass or fail per check, log lines, timings, screenshot paths).
4. Afterwards: undo or delete test saves, people, commitments, voice samples, and settings rows the check created; restore the clipboard and the Windows theme; record results here and in `HANDOFF.md`.

### Running the app

```powershell
pnpm build
Remove-Item Env:ELECTRON_RUN_AS_NODE, Env:GLOSSLY_SMOKE -ErrorAction SilentlyContinue
Start-Process node_modules\electron\dist\electron.exe packages\shell-electron
```

`pnpm dev` also works (hot reload for both renderers; main and preload changes need a restart). Both use Rayan's real `%APPDATA%\Glossly`.

**Dev-only switches** (ignored when packaged):

| Variable | Effect |
| --- | --- |
| `GLOSSLY_USER_DATA=<dir>` | Use another profile folder. The single-instance lock is per profile, so it runs beside the real instance. A copied profile needs `Local State` and `keys\` together (keys are encrypted with a key from `Local State`). |
| `GLOSSLY_NO_CAPTURE=1` | Skip the helper and hotkeys, so a throwaway instance doesn't fight the real one for selections. |
| `GLOSSLY_FORCE_DOT=1` | Fake obstacles above and below every auto selection, to check the dot. |
| `GLOSSLY_NO_MATERIAL=1` | Turn off acrylic and mica, to check the Windows 10 fallback. |
| `GLOSSLY_SMOKE=hotkey\|auto` | Run one capture after `GLOSSLY_SMOKE_DELAY_MS` (3000), log counts and timings, quit. Re-activate the test app within the delay. Setup doesn't open in smoke mode. |
| `GLOSSLY_HELPER_PATH` | Use a different helper exe. |

Destructive checks (Delete all data, Reset settings) run only on a throwaway profile: copy `Local State`, `keys\`, `models\` (and the DB if needed) to `%TEMP%\glossly-throwaway`, run with `GLOSSLY_USER_DATA` and `GLOSSLY_NO_CAPTURE`, delete the folder afterwards.

### `scripts/ui-drive.ps1`

Commands: `notepad [file]` (opens a tab in Rayan's Notepad, doesn't kill his tabs), `focus <process>`, `focustitle <title>` (the settings window is `focustitle Glossly`; Electron processes report no main window handle), `selectall`, `hotkey`, `key <name>` (including `Up`, `Down`, `Esc`, `Tab`), `type <text>`, `drag`, `move`, `click "x,y"`, `shot`, `shotrect`, `diffrect` (pixel diff of a region between shots), `theme get` / `theme "apps,system"`. Screenshots go to `%TEMP%\glossly-live`.

- **Run a whole interaction in one shell command.** The agent's editor takes focus back between commands, which closes a focused bar (blur) and sends later keystrokes into the editor.
- In Claude Code, run it with `pwsh -NoProfile -File` and the sandbox off (Windows PowerShell 5's `Add-Type` writes a DLL to `%TEMP%`, which is denied there). In Cursor, ask for `required_permissions: ["all"]`.
- Coordinates are physical pixels (125% scaling = 1.25 × DIP). Screenshots come back downscaled to 1024 px wide; multiply their coordinates by 1.875. Quote coordinates in PowerShell (`click "750,600"`; bare `750,600` is an array).
- `focus`'s Alt tap can leave Notepad in key-tip mode: send `key Esc` and click into the text before `selectall`.
- `move` uses `SetCursorPos`, which skips the low-level hook Electron uses to forward mouse events; the cursor poll still sees it.
- **Rayan's theme is apps light, system dark** (`theme get` → `1,0`). Restore exactly that after a dark-mode check.
- Double-check a subagent's visual claims on the one screenshot that matters; one once reported an Electron taskbar icon that was another app's.
- Killing the app with `Stop-Process` logs `overlay renderer gone {"reason":"crashed"}` and `worker exited`; that's the kill, not a crash.
- Test pages: `%TEMP%\glossly-live\reply-test.html` (a Slack-like page titled "#design | Acme - Slack" with a message and a reply box; it may need recreating). Who fixtures as text are in `core/src/people/who-judge.test.ts`.

### Measured live (Oct 10)

- Pill (auto path, no toolbar expected): Notepad 117 to 125 ms, Chrome 116 to 117 ms (was 314 to 358 ms before Step 12.2). Two shots 0.35 s and 1.5 s apart were pixel-identical: a shown pill never moves.
- Hotkey path in Notepad: UIA read about 60 ms, total about 96 ms; tier 2 50 to 93 ms.
- First Chromium `selection` call per window used to cost about 300 ms (accessibility nudge); not seen in the Step 12 check.
- Ask: first token 705 ms, done 825 ms. Reply: three drafts in under 9 s. Who (model): 830 ms.

## Live-check backlog

Built and unit tested, not yet seen in the real app. Run as one pass when Rayan is away from the machine (rebuild the helper first, so stop the running instance). Undo every test save.

**Capture and bar**
- [ ] Hotkey with nothing selected shows `1 Ask`, `2 Search`, `3 Paste snippets`; `2` opens Search.
- [ ] Hotkey bar in a text field, then click elsewhere in that app and in another app: the bar closes (look for `overlay was not in front` if blur didn't fire). A Promises date picker or a select dropdown opened from a panel stays open.
- [ ] Select text with an emoji or image in Chrome or Slack and Save: no "OBJ" in Search.
- [ ] Discord tab with an unread count: "Don't show here (Discord)" stores "Discord" (General shows "Discord", no pipe), the rule covers other Discord chats and the Discord app; on the hotkey bar there the menu says "Show here (Discord)", which removes it. Rayan's old "Discord |" rule shows as "Discord" after the first launch (settings migration).
- [ ] Change the hotkey with the recorder; Export.

**Ask and paste**
- [ ] Hotkey in an empty Gmail reply under a thread, Ask "what should I say?": the answer uses the thread. Over a page with nothing selected, Ask "summarize this". A password field gives no surroundings. Watch `context_caret` timing on a large Chromium page.
- [ ] Gmail reply about something saved weeks ago: slot 4 is Write it for here, using only that snippet. Google Docs under a bulleted list: bullets. Slack: Paste snippets gives plain lines. As saved keeps line breaks.
- [ ] Hotkey in an empty Notepad tab, Search, Enter types the item; the copy icon copies without inserting; over non-editable text Enter copies.

**People**
- [ ] Who on a real Outlook web email and a real Discord DM (the two fixtures in `who-judge.test.ts`): right people, no button labels, no shared inboxes, an address ending a sentence is found.
- [ ] Switch away from Who and back: `who looked up {"cached":true}`.
- [ ] A saved "Jordan Hale" and a message from "Jordan": Who asks "Is this the same Jordan?".
- [ ] A contact card (name, role, email, phone) offers Who.
- [ ] Three known people in a selection: "Jordan +2 others" badge.
- [ ] Relationship select on a person card. Reply's "Add to people" opens the Who-style form (readable Create person button, Enter creates, Esc cancels, typing "n" doesn't open None of these). What did I promise shows the same fields per new person and saves them.

**Reply**
- [ ] Select a message on the reply-test page with its auto-focus-on-blur removed: Insert lands in the reply box (`field search {"found":true}`). An email-like page with a search box above and no reply box below copies instead.
- [ ] Reply in Slack or Discord and in Gmail: headings show without the `| kind | tone` tags; Insert and Copy log `reply learned {signals, channel, edited}`.
- [ ] After 5+ short picks in chat, Profile shows "Keeps replies short in work chat/messaging" and the next drafts are all short. Edit 5 replies to lowercase with no final period: `style notes written` and "Writes in lowercase". Forget and the learning switch work.
- [ ] Write my own: `reply learned {"own":true}`. None of these with Shorter and a typed note: three new, shorter drafts.
- [ ] Close the panel mid-stream and reopen: it resumes (`reply drafts {resumed:true}`); reopen later: cached.

**Visualize, Settings, Metrics**
- [ ] Visualize a table: the chart pick renders; switch to Ask and back: `visualized {"cached":true}`.
- [ ] Settings > Saved: filter, search, move, copy, delete.
- [ ] Metrics shows the Features table with real counts.

**Local models and privacy (Step 18)**
- [ ] First launch after the update: a stored Local only shows as Local only in General (settings migration), and `localOnly` is gone from the `settings` table.
- [ ] Keys > Local model with Ollama running (pull a small model first): Connect to Ollama lists its models; the Models tab shows a Local only row and a Local group in the catalog. With Ollama stopped: Connect says it couldn't reach it; Test again on a saved server fails the same way; nothing is saved from a failed connect.
- [ ] Local only with the local model: Ask streams from it, Save finds entities, Who writes notes, What did I promise uses it, Reply drafts; slots 3 and 4 still come from rules (`routed` with `fallback: local_only`). Stop Ollama mid-use: Ask says "Couldn't reach the local model".
- [ ] Local only with no local server: Ask, Reply, and Paste's summary show "Use all models and…" and "Set up a local model" (opens Keys); What did I promise lists pattern rows with the "found by simple patterns" note; Who shows the text-only note with "Use all models"; Visualize charts a TSV.
- [ ] A local server at a LAN address: Keys warns, General's Local only line says it isn't used, and Ask refuses under Local only.

**Tasks and events (Steps 19.1 and 19.2)**
- [ ] A message from a saved person you have open tasks with (a fictional test person; remove them after): Tasks is offered in slot 3 or 4 even without promise words; the panel lists those tasks under "Already open with …"; Done and a new date there apply at once and show in Settings > Tasks.
- [ ] A reply that finishes one ("Here is the budget") and moves another ("can we push the review to Monday?"): rows tagged Mark done and New date with the old → new date; Save updates both (`promises_saved {updated: 2}`), no duplicates.
- [ ] Restating an open task shows it as Already open, unchecked, and Space doesn't check it.
- [ ] An invitation ("Lunch Thursday at 1pm at Northwind Cafe? Can you bring the deck?" from a fictional sender): the bar offers Tasks and events; the panel has the event (day, 1 PM to 2 PM, place) and the task (bring the deck); Save adds both; the event shows in Calendar on its day, in Search, and on the sender's card if saved. A second event on that day shows under "Already that day".
- [ ] "Send the report by Friday 5pm" gives a task, not an event. An all-day event ("offsite Oct 20") saves without times.
- [ ] Event reminders: a timed event 15 minutes ahead shows a toast once; an all-day one at 9:00 on its day (same toast caveat as tasks, Step 22).
- [ ] Local only with no local model: the invitation gives the event and the task by patterns.
- [ ] If one action feels too busy or the model mixes events and tasks up, note it: decision 37's fallback is two actions.
- [ ] Local only with no local model: pattern rows matched to an open task by words show Already open or New date.

**Design system and controls (Step 20.1)**
- [ ] Settings window: every tab shows our controls and no native dropdown, date, time, or checkbox; the sidebar has the two groups; the window opens on Tasks; `#keys` and `#data` (an overlay "Add a key" button, a reminder click) land on Models and Privacy and data. Light and dark.
- [ ] Popovers in the settings window: a Select, the date picker, and a due chip near the bottom of the window open above or scroll inside, stay attached while the page scrolls, close on Esc (focus back on the trigger) and on a click outside.
- [ ] Overlay Tasks and events panel: the person Select, the due chips, and the event's day and time pickers. A picker near the bottom of the panel grows the window while open and shrinks it after, both with the bar below and above the selection. Esc closes only the picker, not the panel; Enter in a picker never saves the panel; Space and the arrows still work on rows.
- [ ] Time picker: type "3pm", "15:30", "3:45p"; arrows and Enter; clearing the start makes the event all day; a new start keeps the event's length.
- [ ] Bar buttons (slots, badges, menu, chips) look as before: no new outline.

**Tasks and Calendar (Step 20.2)**
- [ ] Tasks: quick add "Send Jordan the deck by Friday" (title without "by Friday", due Friday); filters and counts; person filter; edit a title; change and clear a date from the hover button; check one off (slides out, Undo works); Completed shows "Done today"; delete with the confirm; the sidebar count. A reminder click opens Tasks (a task) or Calendar (an event); `#agenda` lands on Tasks.
- [ ] Calendar Week: drag on empty time to create (editor beside the draft), a plain click makes an hour; resize by the bottom edge; move within a day and to another day; overlapping events side by side; tasks in the all-day row check off; the red now line; opens scrolled to 7 AM.
- [ ] Calendar editor: day, start (keeps the length), end, all day, place, add and remove people, save, delete with the confirm; pickers open over the editor and Esc closes only the top one.
- [ ] Calendar Month and Agenda: chips, "N more" opens Agenda for that day, a click on a day adds an event; Agenda's range picker and arrows; the Tasks switch; the tab reopens on the last view.
- [ ] Glass events in light and dark, on mica and without it; General > Week starts on Sunday changes Week, Month, and the date pickers in settings.
- [ ] Migration 6 on Rayan's database: done tasks show "Done" without a date; tasks done from now on show when.

**Motion, key hints, app icon (Step 20.3)**
- [ ] General > Show keyboard shortcuts: Always (a hovered bar shows chips), On hotkey (only a hotkey bar), Never (no chips; 1 to 4 still work on a hotkey bar). Chips sit right of the labels; a long Save label shortens before its chip; nothing moves while the bar is open; the bar stays within 680 px.
- [ ] Motion: buttons squish on press; checks pop with their mark; settings tab changes and task rows rise in; the calendar view switch settles; events lift on hover; bar actions pop in on open and panels' parts rise in. With Windows' Animation effects off, none of it plays.
- [ ] The settings window and its taskbar button show the Glass icon (light and dark taskbar); the tray keeps the plain mark.
- [ ] Spacing (decision 43): every overlay panel (Ask, Save, Who, Tasks and events, Reply, Related, Search, Paste, Visualize) in light and dark: 14 and 16 px icons, the quiet row buttons one height, nothing clipped by the window after the size changes.

**Setup redesign (Step 20.3)** (throwaway profile)
- [ ] Every step on mica, light and dark: dots, the slide from the right going on and from the left going back, the Welcome demo looping, nothing re-animating when a card or tab is picked.
- [ ] Where should AI run saves at once; under All models, Add a key keeps Continue off until a key tests (a bad key shows the provider's error; a good one shows Working with Replace); the Local tab connects to Ollama or LM Studio. Under Local only, Connect a local model is optional.
- [ ] Name required; "alex@example.com, @alexm" lands in Profile as one email and one handle; Enter continues.
- [ ] Models are ready matches the Models tab (Local only with no model: "Ready without a model"). Setting up search starts the download and shows progress; Continue works mid-download and the download finishes after setup.
- [ ] Try it: selecting in the sample ticks the first item (`pill shown` in `main.log`), hovering the pill or the hotkey ticks the second, an action ticks the third; nothing ticks from selections in other apps; leaving the step logs `try-it {active:false}`. Undo anything saved.

**Later steps**
- [ ] Reminder toast and its click (Step 22, installed build).
- [ ] Phase 0 per-app table and toolbar overlap (`evals/capture.md`, Rayan's hand tests).
