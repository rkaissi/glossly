# Glossly handoff

The current state of the build, what to do next, and what to keep in mind. Read this at the start of every session, then follow the links for detail. Update it in the same commit as each chunk of work (`AGENTS.md`).

Last updated Oct 11, 2026: **Step 20.4, the conversation read, is under way: chunk 1 of 4 (the local parser fixes) is done.** Next is chunk 2, the conversation read itself (one shared model read of who wrote what for Reply, Tasks, and Who, with fewer tokens; planned under Next steps). Chunk 1: the local header parser no longer takes a bare badge ("GEN2"), a weekday or date, or a short line above Discord's hover timestamp ("lol") for a speaker; it reads names with spaces ("Casey Lin" / "7:34 PM"); and Reply answers only what the other person wrote after the user's last message. Step 20 (decisions 45 to 47) before it. Decision 47: Reply answers only the other person: one header parser that understands Discord's layout and never takes "Server Tag" for a speaker, the selection trimmed to the other person's messages, the user's headers marked "(the user)" in the thread, and a stricter, more specific prompt. Before it: Reply and Who on chat messages, calmer page motion, popover exits, inline confirms, the event delete that grows in place, quick add's date mark and clearing, week view alignment, the taskbar icon, and the pill turning into the bar without replaying (45, 46); in 20.3: small fixes (44), spacing (43), setup (42), motion, hints, and the icon (41). Nothing from Steps 18 to 20 is checked in the real app yet; the helper changed, so run `pnpm helper:build` (or `pnpm dev`) before the next live run. 573 unit tests pass; `pnpm typecheck` is clean.

## Start here

Glossly is a Windows tray app: highlight text anywhere and a small pill offers actions on it (Ask, Save, Reply, Who is this, Tasks and events, Visualize), or press `Ctrl+Alt+Space` for the full bar. Settings has Tasks and Calendar tabs for what it finds. A C# helper reads selections through UI Automation; Electron hosts the overlay and settings; `packages/core` holds everything OS-neutral.

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
| `docs/brand/` | The Glossly mark, the app icon (Glass) and its backups (Aurora first, then Rim), and the alternatives Rayan liked. |
| `docs/design/` | The HTML mockups Rayan approved for Step 20 (20.1 controls, 20.2 Tasks and Calendar, 20.3 hints, setup, icon, motion). The setup build follows `mockups/20-3-design-pass.html`. |

## Where things stand

- **Built:** spec Phases 0 to 3 (capture, the bar, Ask, Save, settings and setup, people and Who, What did I promise, Reply, Recall, Search, Visualize) plus everything Rayan added along the way: the glass redesign, Save modes, paste with nothing selected, Ask's remember tool, Reply that learns your style, the Saved tab, relationships. Of Phase 4, the metrics view is done (Step 17.1).
- **Seen working live:** most of Phases 0 to 3 as of the Step 16 live check. Everything built after it (Steps 16.7 to 20.3's first chunk, and the fixes since) has unit tests only. `docs/testing.md` has the backlog as a checklist.
- **Not signed off:** Phase 0's per-app checks and toolbar overlap (Rayan's hand tests, `evals/capture.md`); only Notepad, Chrome, and the settings window have been tested.
- **Steps 18 to 20.3's setup (Oct 11):** built with unit tests only (the settings side of 20.1 to 20.3 also previewed in the browser with fictional data); their live checks are in the backlog under "Local models and privacy", "Tasks and events", "Design system and controls", "Tasks and Calendar", "Motion, key hints, app icon", and "Setup redesign". The overlay side of Step 20 (the panel's pickers and its window growing for them, key chips, the overlay's motion) has never been seen running.
- **Step 20.4 in progress:** chunk 1 (local parser fixes) done; chunks 2 to 4 (the read, Reply on it, decision 48 and live checks) planned below. **Not started:** Steps 21 to 23. Step 19 is closed (19.1 and 19.2 built; 19.3, Google Calendar sync, is parked). (Step 17 is closed: its metrics view landed as 17.1, the eval runners moved to Step 21, and the optional decision providers are parked.)
- **On Rayan's machine (last known):** an older build than `HEAD` is running against his real data, from `packages/shell-electron/out`; his Notepad has a few unsaved sample tabs from earlier checks. When it next starts from a fresh build, migration 6 (`commitments.completed_at`) runs on his database and the new settings (`weekStart`, `calendarView`, `keyHints`) take their defaults. Check before assuming anything (see "Before you drive the desktop" in `docs/testing.md`).

## Next steps, in order

Rayan reset this order on Oct 11 (decision 30): finish the features, then polish and the design pass, then one combined testing and evals step, then packaging, then the public README. Step 18 (local models and the privacy choice), 19.1 (Tasks), and 19.2 (events and the Agenda) are done; Google Calendar sync (19.3) is parked; Step 20 is done (20.1, 20.2, and 20.3 with Rayan's review fixes, decisions 41 to 47); **next is Step 20.4, the conversation read (below), then Step 21, testing and evals**. Each step is one or more commits; stop and hand off after each. Until Step 21, rely on unit tests and add new items to the live-check backlog in `docs/testing.md` instead of running live checks.

**Step 19: tasks and calendar, in the app first** (decision 36). What did I promise becomes **Tasks**: one action and one list for promises, requests, and personal todos. Internally the action id stays `promises` and the table stays `commitments` (metrics history and migrations keep working).

*19.1 Tasks (done, Oct 11).*
- A task is a commitment with an optional person: You owe (owner `me`), They owe (`them`), or a personal todo (owner `me`, no person: "renew passport by Nov 1").
- **What you owe someone doesn't depend only on the message.** The panel has two parts:
  - **From this message:** what the text says: new promises, requests, and todos (one Fast call, or patterns without a model, decision 34). Each row is checked against the open tasks with the same people: the model gets those tasks (id, owner, text, due) and says whether the row is **new**, **the same** as an open one (no duplicate), **finishes** one ("sent you the slides"), or **moves** its date ("can we push it to Monday?"). Without a model, a close text match (`canonicalize` plus token overlap) offers "Same as…". Every change waits for the user's confirm.
  - **Already open with these people:** every open task with the author and anyone the message names (matched to saved people), whatever this message says, each with Done and a date change. A message from Jordan shows what you already owe Jordan and what Jordan owes you.
- Settings gets a **Tasks** tab (open and done, filter by person, edit text and date, delete with a confirm). Tasks already show on person cards and in Search; personal todos join them.
- Router: the `promises` score also counts todo-like text ("remember to", "need to", a verb with a date) and a message from someone with open tasks. Label "Tasks" in the bar and More.
- Reminders keep using the commitment notifier.

*19.2 Calendar events (done, Oct 11; decision 37).* Events come from the same call and panel as tasks: the action is **Tasks and events**, and Settings > **Agenda** listed both by day (replaced by the Tasks and Calendar tabs in 20.2). Stored apart (`calendar_events`, migration 5) with their own reminders. **Fallback if one action works poorly:** two actions, Tasks and Add to calendar (a new `event` id), each with its own call and panel; the Agenda and storage stay (decision 37 has the details).

*19.3 Google Calendar sync: parked (Rayan, Oct 11; see Parked below).*


**Step 20: design pass and UI upgrade** (Rayan, Oct 11: "be a designer"). Modern, sleek, minimal, and glossy, native to Windows 11; no illustration pass, no second theme. **Design first, then implement:** each sub-step starts with a mockup (an HTML page built from `theme.css` and `controls.css`, shown in the built-in browser and kept in `docs/design/mockups/` once approved), then the code. Check the real windows with a Sonnet subagent and screenshots, but sparingly (AGENTS.md); screenshots only on fictional sample data (a throwaway profile), never Rayan's.

*20.1 Design system and our own controls (done, Oct 11; decision 39).* Controls in `packages/ui/src/controls/` (Popover, Menu and ActionMenu, Select, Calendar, DatePicker with a field and a row-chip look, DateRangePicker, TimePicker, Segmented, Checkbox, TaskCheck, Switch, ChoiceCards); tokens and buttons in `theme.css`; every native control in both windows replaced; tabs regrouped.

*20.2 Tasks and Calendar (done, Oct 11; decision 40).* `settings/Tasks.tsx` and `settings/Calendar.tsx` with their logic files and tests; Agenda is gone (`#agenda` opens Tasks). The overlay's Tasks and events panel already uses the 20.1 pickers and chips. Rayan's calls from the mockups: glass events tinted from the window background, date words leave quick-add titles, Monday week start with a setting, the calendar remembers its view, Google Calendar's drag gestures. Not done: dragging in Month, recurring events, and Google Calendar sync (parked).

*20.3 Everything else, through the same design pass.*
- ~~Spacing and size audit~~: done (third chunk, decision 43). The page rhythm is at the top of `settings.css`; `--h-xs` is in `theme.css`.
- ~~Keyboard hints setting~~, ~~app icon~~, ~~motion~~: done (first chunk, decision 41). The installer's `.ico` comes from `packages/shell-electron/resources/icon.png` in Step 22.
- ~~Setup redesign~~: done (second chunk, decision 42). `settings/Setup.tsx`, `setup-logic.ts`, `setup.css`; the `setup:tried` push from `Capture` (`index.ts` wires it to the settings window).
- ~~The small fixes~~: done (fourth chunk, decision 44): the dot, long Save labels, the strip, Ask's spaces, Visualize's labels, panels inside the source window, the taskbar flash, the entities backfill. Their live checks are in `docs/testing.md` under "Motion, key hints, app icon".

**Step 20.4: the conversation read (in progress; planned with Rayan, Oct 11).** Why: Reply's local header parsing broke across apps (decision 47, then a review found more; all five fixed in chunk 1, Oct 11):
- On Discord's `name / badge / time` layout, the badge line (`GEN2`) is still recorded as a speaker, so the author becomes "GEN2".
- A display name with a space alone on its line ("Alex Morgan" / "7:34 PM") isn't a header.
- A weekday line above a time ("Friday" / "3:00 PM") becomes a speaker.
- Discord's hover timestamp before a continuation line can turn a short message line ("lol") into a speaker.
- `messagesToAnswer` keeps all of the other person's messages in the selection, including earlier ones the user already answered.

Rayan's direction:
- **Use the model to read the conversation** (who wrote what, who to reply to) instead of more app-specific parsing.
- Keep the local parser as the fallback.
- **Keep model calls, input tokens, and output tokens as low as possible** (latency, cost, Groq free tier).

*The flow after this step*
1. Select: the pill shows, nothing is sent. Bar opens: the router call as today. The router keeps the local parser (fixed), its 600 ms budget, and its own call.
2. Click Reply, Tasks, or Who is this: **one shared conversation read**. It extends the existing Who people call (`readWho`, `prompts/who.md`, cached per input in `Capture.readPeople` with `whoPending` dedupe), so Who, Tasks, and Reply share one Fast call per selection and none adds a second. Output (structured, compact):
   - `messages`: the messages in the selection, in order, at most 8. Each is `{ author, user: boolean, starts }`, where `starts` is the message's first 5 or so words copied exactly. No full quotes in the output (output tokens are the slow part); code cuts the selection at those starts.
   - `people`: the existing Who list, unchanged.
3. Code accepts it (decision 22's rule: the model reads, code accepts):
   - every `starts` must be found in the selection, in order;
   - every author must appear in the captured text or the window title, and is never a UI label (the existing chrome filter);
   - `user` is double-checked with `isMe`.
   Anything that fails falls back to the local parser for that part only.
4. Reply:
   - The message to answer is the other person's messages after the user's last message in the selection. If only theirs are selected, it's all of them; if only the user's, it's a follow-up, as now.
   - Its author goes through `resolvePerson`, so the panel says "Reply to {name}" from the start. It shows a short "Reading the conversation…" while the read runs, skipped when Who or Tasks already read this selection.
   - The Chat call gets the target quoted exactly under "The message to answer", and the thread with the user's headers marked "(the user)" and the target marked "(reply to this)".
   - Decision 47's prompt rules stay.
5. Tasks: the same read gives real authors for You owe / They owe (today it's `det.author` from the parser). Who: the same read, author first.
6. No model (Local only without a local model) or a failed read: the local parser, fixed:
   - a line skipped as a badge is never a speaker;
   - names can be up to 3 words when Title Case or already seen (a speaker, a saved person, the user);
   - weekdays, months, Today/Yesterday, and dates are never names;
   - a time line that isn't followed by a message, or sits inside one, makes no header.

*Fewer calls and tokens (Rayan: as few model calls and tokens as possible)*
- **Calls per selection:** the router (bar open) + at most one read (shared by Who, Tasks, Reply) + the action's own call (Reply's drafts, Tasks' extraction, Ask). Never a second read: the cache key must not change between actions on the same selection.
- **Read input:** the selection plus about 1,200 characters before it and 300 after, not the 6,000-character thread. No voice, preferences, or person records. Output cap about 250 tokens.
- **Reply input:**
  - the thread cut from 6,000 to about 2,500 characters, mostly before the selection;
  - voice samples cut to 3 of at most 300 characters (now 5 of 600);
  - stable parts first (instructions, the user, voice, preferences, notes) and per-message parts last (app, today, message, thread), so Groq's prompt caching can reuse the prefix (cached tokens don't count toward rate limits).
- **Reply output cap by channel:** about 450 tokens for chat, 900 for email (now 1,200 for everything).
- **Consider later, with numbers from Step 21:** skip the read when the local parse is unambiguous (one header, Slack-style same-line, a known person). Not now: Discord looked unambiguous too.

*Groq free tier (checked Oct 11 from published figures; Rayan's console has the exact numbers):*
- Per model, for the whole organisation: `openai/gpt-oss-120b` allows 30 requests a minute, 1,000 a day, 8,000 tokens a minute, and 200,000 tokens a day. Other models are similar or tighter on tokens.
- Budget per Reply after this step: the read is about 900 tokens in and 250 out on the Fast model; the drafts about 2,000 in and 450 out on the Chat model. That's roughly 3 Replies a minute before a model hits 8,000 TPM.
- Fast and Chat are different models with separate buckets (decision 25), which is why spreading roles helps.
- Log prompt and completion token counts per action in metrics (codes and counts only), so Step 21 can check real usage.

*Build order (one commit each, docs and the HANDOFF updated in the same commit, stop after each):*
1. ~~Local parser fixes~~: done (Oct 11). `headers(text, known)` in `router/features.ts` takes a `KnownName` (`knownName(me, people)`: the user and saved people), so a lowercase or several-word name counts once seen; a line under a header (badge, time) is never a speaker; days, months alone, and dates never are; a one-word chat line ("lol", "ok") above a time is a hover timestamp, not a header, unless it already spoke; a time followed by another time makes no header. `messagesToAnswer` keeps only their messages after the user's last one (`droppedEarlier`). Tests in `router/headers.test.ts` and `actions/reply.test.ts`. Known limit: a first-time one-word speaker whose name is a chat word ("Sure") is missed until chunk 2's read.
2. The conversation read: prompt and schema (extend `who.md` and `readWho`), code acceptance and fallback, Who and Tasks switched to it, token caps, and tests with a fake model.
3. Reply on the read: the target, the marked thread, "Reply to" from the read with the reading state, the token trims above, and tests that assert the recipient and the target (not just the prompt text).
4. Decision 48 in `docs/decisions.md`; live checks in `docs/testing.md` (a fictional Discord DM with a server tag, a Slack thread, an email thread); and a conversation-read eval added to Step 21's list.

**Step 21: testing and evals, all in one step.** Run when Rayan is away from the machine, through a subagent (AGENTS.md).
- The whole live-check backlog in `docs/testing.md`, including everything Steps 18 to 20 added. Fix what it finds.
- Export and Delete all data checked live (Delete all only on a throwaway profile).
- Rayan's per-app hand tests in `evals/capture.md` (the Phase 0 sign-off, formerly Step 14). Fix what they turn up (apps where UIA reads nothing, pill placement next to real toolbars, additions to `DEFAULT_HOTKEY_ONLY`) and record results in `STATUS.md`.
- Eval runners for every eval in the spec's table: commitments extraction, the date resolver (`resolveDue` has 60 unit cases; an eval adds model-in-the-loop phrases), Recall ranking, Visualize, the router (exists), and people extraction from the Who fixtures in `core/src/people/who-judge.test.ts`. Follow `evals/router.eval.ts`: skip without `GROQ_API_KEY`, retry on 429, fail on a high error rate, write to `evals/results/`, print with `print-results.mjs`.
- Then **one** `pnpm eval` run (Rayan approved one; Groq free tier; no comparison evals, decision 35). Record every number in `STATUS.md` and `docs/testing.md`, including the re-tuned router prompt's slot match. Pre-agreed rule: if the router's slot match stays under the rules' 90%, use the model only for `content_type` and `best_collection` and compute the people and commitment scores from rules. Who's own model call stays.

**Step 22: packaging.** `electron-builder` config (none exists yet; `pnpm dist` runs `helper:publish` then `electron-builder --win`): the helper's `helpers/windows/publish` output into `resources/helper` (`paths.ts` already looks there when packaged), `asarUnpack` for sqlite-vec's DLL and onnxruntime (`services.ts` already rewrites the sqlite-vec path to `app.asar.unpacked`), an NSIS installer with the Step 20 icon (`packages/shell-electron/resources/icon.png`, Glass; electron-builder makes the installer's `.ico`; ship `icon.png` and `icon.ico` in resources too, which `appIconPath()` and `appIcoPath()` read when packaged), and unsigned GitHub Releases as in the spec's "Distribution to testers" (with the SmartScreen note). Test the installed app end to end through a subagent, including the reminder toast that never appeared in the dev build (Windows toasts likely need the installer's Start Menu shortcut for `com.glossly.app`). Before publishing a release or making the repo public, revisit the git history note under "Things to remember".

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
- No `pnpm eval` unless he asks (Groq free tier, per model for the whole organisation: about 30 requests a minute, 1,000 a day, 8,000 tokens a minute, 200,000 tokens a day; cached prompt tokens don't count).

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

**Controls and styles (Step 20.1)**
- Plain `<button>` now has an outline (`theme.css`). A button with its own flat look (bar slots, badges, chips, icon buttons, calendar days) sets `box-shadow: none`; `overlay.css` lists the bar's. `button.danger` is filled red; `icon-btn danger` stays quiet and turns red on hover.
- Use the controls in `controls/`, never native `<select>`, date, time, or checkbox inputs. Their triggers carry `data-control`; a panel's key map should skip events from them (see `PromisesPanel`'s `onKeyDown`). Keys inside a popover never reach the panel.
- A popover closes when its anchor scrolls out of view, so open one only on a visible trigger. Popovers stack: Esc and clicks outside close only the top one, so a picker can open over the event editor. In the overlay, `RoomContext` grows the window for a popover that doesn't fit; the settings window has no provider.
- Rayan's instance runs from `packages/shell-electron/out`: build elsewhere while it runs (`pnpm exec electron-vite build --outDir <scratchpad>`). To preview the settings page without the app, serve the built `renderer/` with a stub `window.glossly` that returns fictional data (how 20.1 was checked).

**Motion and key hints (Step 20.3, decision 41)**
- Settings pages enter with one 160 ms fade (`page-in`), skipped on quick switches; don't add entry animations to things that render with the page (decision 45). Popovers exit through a copy (`leave` in `Popover.tsx`).
- Animate with the spring tokens in `theme.css` (`--spring-soft`, `--spring-pop`, `--spring-gentle` and their `-ms` durations) and the shared keyframes (`rise-in`, `pop-in-small`, `squash-pop`); exits use `--ease-in`, short, no bounce. The generator for new springs is in `docs/design/mockups/20-3-design-pass.html` (`spring()`); keep overshoot under 10%.
- Spacing (decision 43): settings cards and settings are padded `var(--s-4) 20px`, 16 px apart, groups 40 px apart (`section > h3`); row icon buttons are `icon-btn sm` with 14 px icons; overlay icons are 14 or 16 px; quiet buttons in overlay panel rows use `--h-xs`.
- Every button squishes on `:active` through `transform`; a button that needs its own transform should opt out (toggles with a role already do).
- In the overlay the glass is the window, so never scale or move a container there; animate what's inside.
- Key chips: the bar reads `s.keyHints` once, in `Expanded`'s `hints` state, when it opens; `s.keyboard` still decides whether the keys work.
- Before-and-after shots: the built-in browser pane is often too narrow and its screenshots time out. Headless Edge over CDP (`--remote-debugging-port`, `Emulation.setDeviceMetricsOverride` 960×700, `Input.insertText` to type, `Page.captureScreenshot`) gives exact window-size shots of the built page with the stub. Its child processes outlive the launcher: kill them by their temporary `--user-data-dir` afterwards, or the next run connects to the old instance and serves stale files.
- Previewing: the built-in browser shows files outside the project as static snapshots, and the mockups and the built settings page need a server. A tiny Node server in the scratchpad that serves the mockups, `/theme.css`, `/controls.css`, and a built `renderer/` copy (with JavaScript sent as `text/javascript`) works; for the settings page, inject a `stub.js` that defines `window.glossly` with fictional data before the bundle loads.

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
- Python on Windows writes CRLF in text mode; when a script rewrites repo files, pass `newline='\n'` (the repo is LF, `.gitattributes`).
- In Claude Code's Bash tool, long quoted heredocs with backticks sometimes fail to parse ("unexpected EOF"); write the script to a scratchpad file and run it instead.

**API keys**
- The app gets keys only through Settings > Models (formerly Keys; `safeStorage`, `%APPDATA%\Glossly\keys\`). Rayan's Groq key is saved there.
- `GROQ_API_KEY` is a Windows user environment variable, used only by command-line evals. Shells started before it was set don't see it: `$env:GROQ_API_KEY = [Environment]::GetEnvironmentVariable('GROQ_API_KEY','User')`. Never print or log it.

## Things Rayan has to do himself

- Hand-test capture across the apps in `evals/capture.md` (part of Step 21; can be done any time before it).
- Answer the open questions above.
