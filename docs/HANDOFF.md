# Glossly handoff

The current state of the build, what to do next, and what to keep in mind. Read this at the start of every session, then follow the links for detail. Update it in the same commit as each chunk of work (`AGENTS.md`).

Last updated Oct 11, 2026: **Step 19.2 landed** (decision 37): calendar events come from the same call as tasks (the action is now **Tasks and events**), stored locally (migration 5), listed with tasks by day in Settings > **Agenda**, in Search, on person cards, and with reminders before they start; unit tested only. Before it, **Step 19.1** (decision 36): What did I promise became Tasks, with the open tasks per person beside what the message says, rows that finish or move an open task, and personal todos. Before it, **Step 18** (decision 34): the privacy choice (All models / Local only) replaces the checkbox, a local model server (Ollama, LM Studio) works in Keys, Models, and the model layer, and with no local model Local only falls back to code, including What did I promise by sentence patterns. None of 18, 19.1, or 19.2 is checked live; Step 18 never ran against a real Ollama. 477 unit tests pass; `pnpm typecheck` is clean.

## Start here

Glossly is a Windows tray app: highlight text anywhere and a small pill offers actions on it (Ask, Save, Reply, Who is this, What did I promise, Visualize), or press `Ctrl+Alt+Space` for the full bar. A C# helper reads selections through UI Automation; Electron hosts the overlay and settings; `packages/core` holds everything OS-neutral.

| Doc | Read it for |
| --- | --- |
| `AGENTS.md` | Standing working rules. |
| this file | State, next steps, open questions, gotchas, environment. |
| `docs/decisions.md` | Every deviation from the spec and every choice Rayan made, with reasons. Numbered; code cites the numbers. |
| `docs/architecture.md` | Processes, packages, the capture pipeline, routing and slots, LLM layer, data and migrations. |
| `docs/features.md` | What each feature does, where it lives, and whether it's been seen working live. |
| `docs/testing.md` | Unit tests, evals and their results, how to run live checks, and the **live-check backlog**. |
| `docs/history.md` | Step-by-step build log with commit hashes ("Step 15.4" → what and where). |
| `STATUS.md` | The spec's status write-up for Rayan, per phase (spec: "Instructions for the coding agent", item 8). |
| `docs/Highlight-to-Action App Prototype Spec.md` | The original spec. Its Phase 4+ sections, Data model, Evals and local metrics, Milestones, and Distribution to testers still guide the remaining steps; `docs/decisions.md` overrides it where they differ. |
| `helpers/protocol.md` | Every helper command, error, and event. Read before touching the helper or `capture.ts`. |
| `evals/capture.md` | Rayan's hand-test sheet for Phase 0. |
| `docs/brand/` | The Glossly mark and the alternatives Rayan liked. |

## Where things stand

- **Built:** spec Phases 0 to 3 (capture, the bar, Ask, Save, settings and setup, people and Who, What did I promise, Reply, Recall, Search, Visualize) plus everything Rayan added along the way: the glass redesign, Save modes, paste with nothing selected, Ask's remember tool, Reply that learns your style, the Saved tab, relationships. Of Phase 4, the metrics view is done (Step 17.1).
- **Seen working live:** most of Phases 0 to 3 as of the Step 16 live check. Everything built after it (Steps 16.7 to 16.14, 17.1, 18, and the fixes since) has unit tests only. `docs/testing.md` has the backlog as a checklist.
- **Not signed off:** Phase 0's per-app checks and toolbar overlap (Rayan's hand tests, `evals/capture.md`); only Notepad, Chrome, and the settings window have been tested.
- **Steps 18, 19.1, and 19.2 (Oct 11):** built with unit tests only; their live checks are in the backlog under "Local models and privacy" and "Tasks and events".
- **Not started:** Steps 20 to 23 below. Step 19 is closed (19.1 and 19.2 built; 19.3, Google Calendar sync, is parked). (Step 17 is closed: its metrics view landed as 17.1, the eval runners moved to Step 21, and the optional decision providers are parked.)
- **On Rayan's machine (last known):** an older build than `HEAD` is running against his real data; his Notepad has a few unsaved sample tabs from earlier checks. Check before assuming anything (see "Before you drive the desktop" in `docs/testing.md`).

## Next steps, in order

Rayan reset this order on Oct 11 (decision 30): finish the features, then polish and the design pass, then one combined testing and evals step, then packaging, then the public README. Step 18 (local models and the privacy choice), 19.1 (Tasks), and 19.2 (events and the Agenda) are done; Google Calendar sync (19.3) is parked; **next is Step 20, the design pass: 20.1 the design system and our own controls, then 20.2 the Tasks and Calendar tabs, then 20.3 the rest**. Each step is one or more commits; stop and hand off after each. Until Step 21, rely on unit tests and add new items to the live-check backlog in `docs/testing.md` instead of running live checks.

**Step 19: tasks and calendar, in the app first** (decision 36). What did I promise becomes **Tasks**: one action and one list for promises, requests, and personal todos. Internally the action id stays `promises` and the table stays `commitments` (metrics history and migrations keep working).

*19.1 Tasks (done, Oct 11).*
- A task is a commitment with an optional person: You owe (owner `me`), They owe (`them`), or a personal todo (owner `me`, no person: "renew passport by Nov 1").
- **What you owe someone doesn't depend only on the message.** The panel has two parts:
  - **From this message:** what the text says: new promises, requests, and todos (one Fast call, or patterns without a model, decision 34). Each row is checked against the open tasks with the same people: the model gets those tasks (id, owner, text, due) and says whether the row is **new**, **the same** as an open one (no duplicate), **finishes** one ("sent you the slides"), or **moves** its date ("can we push it to Monday?"). Without a model, a close text match (`canonicalize` plus token overlap) offers "Same as…". Every change waits for the user's confirm.
  - **Already open with these people:** every open task with the author and anyone the message names (matched to saved people), whatever this message says, each with Done and a date change. A message from Jordan shows what you already owe Jordan and what Jordan owes you.
- Settings gets a **Tasks** tab (open and done, filter by person, edit text and date, delete with a confirm). Tasks already show on person cards and in Search; personal todos join them.
- Router: the `promises` score also counts todo-like text ("remember to", "need to", a verb with a date) and a message from someone with open tasks. Label "Tasks" in the bar and More.
- Reminders keep using the commitment notifier.

*19.2 Calendar events (done, Oct 11; decision 37).* Events come from the same call and panel as tasks: the action is **Tasks and events**, and Settings > **Agenda** lists both by day. Stored apart (`calendar_events`, migration 5) with their own reminders. **Fallback if one action works poorly:** two actions, Tasks and Add to calendar (a new `event` id), each with its own call and panel; the Agenda and storage stay (decision 37 has the details).

*19.3 Google Calendar sync: parked (Rayan, Oct 11; see Parked below).*


**Step 20: design pass and UI upgrade** (Rayan, Oct 11: "be a designer"). Modern, sleek, minimal, and glossy, native to Windows 11; no illustration pass, no second theme. **Design first, then implement:** each sub-step starts with a mockup (an HTML page in the scratchpad built from `theme.css`, opened in the built-in browser), then the code. Check the real windows with a Sonnet subagent and screenshots, but sparingly (AGENTS.md); screenshots only on fictional sample data (a throwaway profile), never Rayan's.

*20.1 Design system and our own controls.*
- **Spacing and sizing scale** in `theme.css`: a 4 px grid (4, 8, 12, 16, 24, 32), fixed control heights (28 compact, 32 default, 36 large), icon sizes (14 in rows and chips, 16 in buttons and nav), one radius scale, and row padding used the same way in every list. Today icon buttons and the red trash buttons are too big, rows are cramped, and margins differ from tab to tab.
- **Replace every native Windows control** with our own glossy ones (built in-house, no shadcn unless ours can't look right; no new dependency without asking): a **Select** (button plus a floating menu with check marks, keyboard and type-ahead), a **Date picker** (a small month calendar in a popover, with Today, Tomorrow, Next week, and No date shortcuts), a **Date range picker** (two months, quick ranges such as This week, Next 7 days, This month), a **Time picker** (typed or picked in 15-minute steps), a **Segmented control**, a **Checkbox** and round task check, a **Switch**, and a **Menu** for row actions. One `Popover` primitive under all of them (positioning inside the window, Esc and click-outside to close, focus return). They replace every `<select>`, `<input type="date">` and `type="time"`, and checkbox in both windows (overlay panels included: Tasks and events, Reply, Save, Who, Models, General, Keys, People).
- **Buttons:** primary, secondary, ghost, and icon sizes from the scale; **destructive buttons are filled red** (solid red, white text): Delete person, Delete all data, Reset settings, Merge, Remove key, alias, or sample, Delete saved item, Delete task, Delete event. The inline confirm stays. A row's delete moves into its hover actions or a "…" menu instead of a big red button on every row.
- Inputs inside list rows look like text until hovered or focused (no permanent boxes around every task title).

*20.2 Tasks and Calendar, redone as two tabs* (replacing Agenda; inspiration: Google Tasks, Google Calendar, Apple Reminders, Things, Todoist, Linear, Notion Calendar, Fantastical; look at their current versions first).
- **Tasks tab:** a quick-add row (text, then a due chip with the date picker, Enter adds); sections Overdue, Today, Upcoming (by day), No date, and a collapsible Completed; filter chips (All, You owe, They owe, Todos) and a person filter (the custom Select); each row is the round check, the title (edits in place), the person as a quiet link, and a due chip, with hover actions (change date, open person, delete). Compact, even spacing; no boxes around every field.
- **Calendar tab:** a real calendar view with **Month, Week, and Agenda (list)** modes, Today and previous/next buttons, and a **date range** for the Agenda list (the range picker). Events as colored blocks in Week (by time) and chips in Month; tasks with a due date shown on their day (as small checkable items, toggleable). Clicking an empty slot or day adds an event there (title, day, start and end with the time picker, place); clicking an event opens a small editor popover (title, day, times, all day, place, people, delete).
- The overlay's Tasks and events panel uses the same row and chip styles and the new pickers.
- If one tab works better after trying both, say so to Rayan before merging them back.

*20.3 Everything else, through the same design pass.*
- **Spacing and size audit of every tab and panel** (Profile, People, Saved, Keys, Models, General, Data, Metrics, and every overlay panel): consistent margins, smaller icons and icon buttons, more room between groups.
- **Keyboard hints setting.** General gets "Show keyboard shortcuts": **Always**, **On hotkey** (today's behavior, the default), **Never**. Today the hint replaces the button's icon; instead keep the icon on the left of the label and put the key chip on the right (`overlay/main.tsx`, `overlay.css`, `keys.ts`). The keyboard map itself stays live whenever the bar has focus, whatever the setting. Mind the bar width (`MAX_W`, the 172 px slot cap) and the Step 13 rule that nothing moves when hints appear.
- **Setup redesign.** Take cues from the onboarding in Raycast, Arc, and the ChatGPT and Claude desktop apps: one focused screen per step with a large heading and one short line, a clear primary button, progress dots, a live "try it" moment, and nothing on screen that the step doesn't need. Keep the steps' content (Welcome, You, Keys, Models, Try it), the privacy choice and local model card from Step 18, and the embedding download notice. Look at the current versions of those onboardings before designing.
- **App icon** for the window, tray, taskbar, and installer, built from the C1 mark (`docs/brand/`); replaces the code-drawn tray icon (`tray.ts`) and Electron's default window icon.
- Motion on the bar, panels, popovers, and tab changes (the current fades are the floor) and one accent color on the glass (lifts the "no accent" part of decision 13); the calendar's event colors come from the same palette.
- **The small fixes:**
  - The dot sits 4 DIP right of the mouse-up point and can cover the next letter (`placement.ts`, `anchorX + 4`); a real fix needs the last line's rect from the helper.
  - Long Save labels truncate at the 172 px slot cap ("Save to People not…").
  - The "Nothing selected…" strip stays above the paste panel and is truncated there.
  - Ask's Markdown rendering once joined "at 10 a.m." into "at10a.m.." (`markdown.ts`).
  - Visualize's x labels sometimes rotate 90°.
  - Panels can extend past the source window onto whatever is below.
  - Notepad's taskbar button flashes after the tier-2 hand-off (a Windows refusal in `Focus.cs`; harmless, fix if cheap).
  - Items saved under Local only with no local model never get entities (decisions 12 and 34); offer a backfill when switching to All models or adding a local model, if it's cheap.

**Step 21: testing and evals, all in one step.** Run when Rayan is away from the machine, through a subagent (AGENTS.md).
- The whole live-check backlog in `docs/testing.md`, including everything Steps 18 to 20 added. Fix what it finds.
- Export and Delete all data checked live (Delete all only on a throwaway profile).
- Rayan's per-app hand tests in `evals/capture.md` (the Phase 0 sign-off, formerly Step 14). Fix what they turn up (apps where UIA reads nothing, pill placement next to real toolbars, additions to `DEFAULT_HOTKEY_ONLY`) and record results in `STATUS.md`.
- Eval runners for every eval in the spec's table: commitments extraction, the date resolver (`resolveDue` has 60 unit cases; an eval adds model-in-the-loop phrases), Recall ranking, Visualize, the router (exists), and people extraction from the Who fixtures in `core/src/people/who-judge.test.ts`. Follow `evals/router.eval.ts`: skip without `GROQ_API_KEY`, retry on 429, fail on a high error rate, write to `evals/results/`, print with `print-results.mjs`.
- Then **one** `pnpm eval` run (Rayan approved one; Groq free tier; no comparison evals, decision 35). Record every number in `STATUS.md` and `docs/testing.md`, including the re-tuned router prompt's slot match. Pre-agreed rule: if the router's slot match stays under the rules' 90%, use the model only for `content_type` and `best_collection` and compute the people and commitment scores from rules. Who's own model call stays.

**Step 22: packaging.** `electron-builder` config (none exists yet; `pnpm dist` runs `helper:publish` then `electron-builder --win`): the helper's `helpers/windows/publish` output into `resources/helper` (`paths.ts` already looks there when packaged), `asarUnpack` for sqlite-vec's DLL and onnxruntime (`services.ts` already rewrites the sqlite-vec path to `app.asar.unpacked`), an NSIS installer with the Step 20 icon, and unsigned GitHub Releases as in the spec's "Distribution to testers" (with the SmartScreen note). Test the installed app end to end through a subagent, including the reminder toast that never appeared in the dev build (Windows toasts likely need the installer's Start Menu shortcut for `com.glossly.app`). Before publishing a release or making the repo public, revisit the git history note under "Things to remember".

**Step 23: the public README.** Rewrite `README.md` as the repo's front page for when it goes public: what Glossly is in one or two lines, a short demo (GIF or video) and screenshots of the pill, the bar, a few panels, and settings in light and dark, the features (from `docs/features.md`, in plain words), privacy (what stays local, Local only, keys in `safeStorage`), install from GitHub Releases (with the SmartScreen note), requirements (Windows 11; a Groq, OpenAI, or Anthropic key, or a local model), building from source, the tech stack, project layout with links to `docs/`, the roadmap (macOS later), and the license (ask Rayan which). Capture screenshots and the demo with a subagent on fictional sample data only (AGENTS.md first section), never Rayan's real data. Keep `STATUS.md` and `docs/` as the contributor docs and link them.

**Parked (Rayan: "way later" or not now):**
- Google Calendar sync (was Step 19.3; parked Oct 11). Open questions for when it comes back: OAuth with a Google Cloud project (one client for Glossly, or each user's own), what syncs which way (events only, two-way, or tasks to Google Tasks too), and blocking it under Local only (Google is off this computer). The local Agenda (decision 37) stays the source either way.
- A monthly subscription with a cap on Ask, as a third privacy choice beside All models and Local only, enforced in the model layer next to the Local only refusal. Not before packaging.
- Optional decision providers for the router (the spec's Jev via OpenRouter and OpenAI Decisions, Phase 4): a `DecisionProvider` (`router/types.ts`) per API behind a setting in the Models tab. Scrapped from the plan on Oct 11; check their current docs first if it comes back, since both may have changed or no longer exist.

## Open questions for Rayan

None right now. Everything he was asked has been answered and is recorded in `docs/decisions.md` (Oct 11: comparison evals skipped and the router on rules under Local only, decision 35; What did I promise merges into Tasks, Who is this stays separate, decision 36).

## Things to remember

**Working on this machine**
- The app runs against Rayan's real data in `%APPDATA%\Glossly`. Undo every test save and remove every test row (people, commitments, voice samples, settings like `saveMode` or `identity`) a check creates.
- Rayan may be at the machine. Check `main.log`, running instances, and DB counts before driving the desktop, and don't stop his instance without asking.
- Desktop and end-to-end testing goes through a subagent (Composer or Grok in Cursor; Sonnet in Claude Code). See `docs/testing.md` for how to brief it and the `ui-drive.ps1` quirks.
- His debug view is off; diagnose pills from `main.log` (`pill shown`, `pill obstacles`, `overlay closed`, `routed`) and the `events` table.
- His Windows theme is apps light, system dark (`1,0`). Restore it after dark-mode checks.
- No `pnpm eval` unless he asks (Groq free tier: 1,000 requests a day, 8,000 tokens a minute, per model).

**Conventions in the code**
- Every model call goes through `AiSdkLlm` with an `action` name and a prompt in `core/prompts/`, so the privacy choice and fallbacks apply. To decide between a model path and a code path, ask `llm.hasModel(role)` (it already follows Local only), not `settings.privacy`; read `privacy` only to word the message (decision 34). Prefer structured output with `z.enum` where options are fixed (decision 22); streamed text only where streaming matters (decision 23).
- New actions join `CONTEXTUAL_ACTIONS` or `EMPTY_ACTIONS` and get a score; never add a third visible slot.
- Schema changes are new migrations; default changes to stored settings are new `SETTINGS_MIGRATIONS` entries. Never edit a shipped one.
- Helper changes update `helpers/protocol.md`, `helpers/fixtures/`, and `core/src/helper/protocol.ts` together, plus a `--check` case when the command is deterministic.
- New push channels go in the preload's `Record<PushChannel, true>` (typecheck enforces it). The UI imports types only from `@glossly/core/api`.
- React component files export only components (Fast Refresh). Use CSS files and the `theme.css` tokens, not inline styles; new panels follow the Step 13 design (decision 13).
- Logs and metrics carry codes, counts, and timings, never selected text, keys, or site keys.
- Nothing destructive without an inline confirm and a red control. People are never created or merged without a confirm.
- Keep everything outside `helpers/windows` OS-neutral (macOS later).
- Docs and tests use fictional people and `example.com` addresses only (AGENTS.md, first section). The current files are clean, but commits before `e03a177` still hold some real names, screenshot-derived addresses, and the personal commit email. Rayan chose (Oct 11) not to rewrite history for now; revisit before the repo goes public (a `git filter-repo` pass plus a force-push).

**Local models (Step 18)**
- `@ai-sdk/openai-compatible` 3.0.67 with `supportsStructuredOutputs: true`: Ollama and LM Studio both take `response_format: json_schema` (LM Studio rejects `json_object`). Local models get `tools: false`, so Ask's remember tool is not offered on them.
- Neither Ollama nor LM Studio is known to be installed here; the Step 21 pass needs one with a small model pulled (for example `ollama pull qwen3:4b`).

**Known platform limits**
- WinForms (.NET Framework) text boxes expose no TextPattern; those apps need the hotkey's copy fallback. WPF counts `\r\n` as one character (handled).
- Windows sometimes refuses to bring the overlay forward; the shell forces it through the helper and re-checks clicks outside (`overlayInFront`).
- DWM's corner radius is fixed at 8 px. After a focused overlay is hidden, the next acrylic draws paler unless the material is cycled (handled by `materialStale`).
- `setFocusable()` drops `skipTaskbar` on Windows; the overlay re-sets it after every change.
- After selecting a message in a chat app, focus is on the message list, not the reply box; Reply's Insert searches for the field (`focus_field`).

## Environment

Windows 11 23H2 (build 22631), display at **125% scaling** (helper coordinates are physical pixels, 1.25 × DIP).

**Toolchain**
- Node v24.21.0 (nvm-windows, `C:\Program Files\nodejs`); pnpm 12.10.1 via corepack (`packageManager` in `package.json`). pnpm 12 uses `allowBuilds` in `pnpm-workspace.yaml`, not `onlyBuiltDependencies`. Use `pnpm exec vitest ...`, not `npx`.
- .NET SDK 10.0.401 and the Windows Desktop runtime 10.0.12 (the helper). Visual Studio 2026 Community is installed.
- Pinned (all checked for compatibility): electron 44.7.0 (Node 24.21 inside), electron-vite 5.0.0, vite 7.3.7 (electron-vite 5 doesn't support Vite 8), @vitejs/plugin-react 5.2.0, react 19.3, typescript 7.0.2, ai 7.0.137 with @ai-sdk/groq 4.0.59, @ai-sdk/openai 4.0.91, @ai-sdk/anthropic 4.0.78, zod 4.6.5, sqlite-vec 0.1.9, @huggingface/transformers 4.3.1, uuidv7 1.2.1, vitest 5.0.3, electron-builder 26.15.3, lucide-react 1.48.0, FlaUI.UIA3 5.0.0.

**Commands**

```powershell
pnpm install
pnpm dev                 # builds the helper, starts the app with hot reload
pnpm build               # helper + production build into packages/shell-electron/out
pnpm test                # unit tests only
pnpm typecheck
pnpm helper:record --check   # replay helper fixtures against the live binary
pnpm eval                # only when Rayan asks
```

**Agent shell quirks (Cursor and Claude Code on this machine)**
- Cursor's shell puts its own Node 22 first on PATH: prefix with `$env:PATH = "C:\Program Files\nodejs;" + $env:PATH;`.
- It can set `ELECTRON_RUN_AS_NODE`; clear it before launching Electron. Also clear `GLOSSLY_SMOKE`.
- It sets `NUGET_PACKAGES` to a sandbox cache with a broken `flaui.uia3` (`NU5037: missing nuspec`), which breaks `pnpm helper:build` and so `pnpm dev`. Run `Remove-Item Env:NUGET_PACKAGES` first.
- Empty output from the shell: request `all` permissions. PowerShell shows pnpm's stderr as red `NativeCommandError` even on success; check `$LASTEXITCODE`.
- If `electron-vite` fails with "Cannot find module ...\packages\shell-electron\node_modules\electron-vite", delete that package's `node_modules\.bin` (stale shims from an old install).
- The helper exe is locked while Glossly runs; stop the app before `pnpm helper:build`.

**API keys**
- The app gets keys only through Settings > Keys (`safeStorage`, `%APPDATA%\Glossly\keys\`). Rayan's Groq key is saved there.
- `GROQ_API_KEY` is a Windows user environment variable, used only by command-line evals. Shells started before it was set don't see it: `$env:GROQ_API_KEY = [Environment]::GetEnvironmentVariable('GROQ_API_KEY','User')`. Never print or log it.

## Things Rayan has to do himself

- Hand-test capture across the apps in `evals/capture.md` (part of Step 21; can be done any time before it).
- Answer the open questions above.
