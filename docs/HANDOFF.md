# Glossly handoff

The current state of the build, what to do next, and what to keep in mind. Read this at the start of every session, then follow the links for detail. Update it in the same commit as each chunk of work (`AGENTS.md`).

Last updated Oct 13, 2026. **Step 21 is nearly done:** end-to-end done (decisions 63 to 65), evals done for the router, Who, Tasks, the Qwen comparison, and Recall (decision 67). **Tasks done** (Oct 13 afternoon: the check, a full 18-case run, and decision 68's fixes; see `docs/testing.md`). **Left:** Visualize (skipped: gpt-oss-20b's rolling day ran out again), then the real-use record and the final numbers (see **Next** below). Everything is committed and pushed. Steps 20.5 to 20.8 (decisions 49 to 62) and Rayan's delete-confirm pass (decision 66) are done.

**Delete confirms (Oct 12 evening; decision 66).** Trash morph for Saved, Tasks, calendar events, person header (pencil rename beside it; warning only when armed), and Profile voice/learned rows; chips keep the small x; Merge / Delete all / Reset use borderless `InlineConfirm`; event Save stays visible but disabled while delete is armed or the event is unchanged. Red-bordered confirm boxes are gone.

**Step 21 end-to-end (Oct 12; decisions 63 to 65).** Five passes on a throwaway profile with fictional test pages, through Sonnet subagents (A Setup and settings, B capture/Ask/People/Visualize, C Tasks and Calendar, D Reply and chat, E stopped by Rayan). Most of the backlog passed; results per pass, and what wasn't run, are under "Step 21 end-to-end" in `docs/testing.md`, and unchecked items stay in the backlog.
- *Fixed:* Tasks took tasks from lines around the selection and offered the user as a new person (decision 63); Ask in an empty Chromium reply box got only the box, not the thread (`context_caret` reads the page around a field; `helpers/protocol.md`); the settings window stayed pale after a theme switch (mica redrawn); the empty bar's More menu never drew its actions, so Paste snippets vanished when Write it for here took the slot; Reply on a whole quoted email chain answered the oldest quoted ask (decision 64); the debug view defaulted on, quick add ignored the person filter, Who listed "Copying" as a person, Visualize put a tenfold-smaller series flat on one axis, a trailing unread count stayed in a site rule, and a Reply draft answered the user's own earlier line (decision 65).
- *Not rechecked live:* the More menu, email-chain, and decision 65 fixes (unit-tested).
- *Open, for the evals or later:* Tasks read "Can you send me the slides" from Jordan as They owe (model; the Tasks eval measures it); the settings window's taskbar button shows Electron's icon in the dev build (title bar and tray are Glass; check the installed build in Step 22); Task Manager's helper icon unseen; the real Discord, Slack, Gmail, and Outlook apps (only look-alike pages were used) and a real trackpad are Rayan's to try.
- *Lessons for live checks:* brief subagents to check each check once, reuse test data, prefer logs to screenshots, and focus the target window before every input (one pass's clicks landed in Rayan's Claude window). Rayan found the full passes too token-heavy.

**Evals (Oct 13).** Groq's daily limits refill continuously (one request back every 86.4 s, headers checked on Oct 13), so there's no reset time to wait for. Runners now check the day's requests left every 5 cases and stop early if the rest won't fit (cases run round-robin across kinds, so a cut stays balanced; `budget_checks` in each results file). **Router done:** Qwen 3.8, 20 cases, 100% type and 100% slots (rules 95% on the same cases, 86.7% on all 60) after updating 10 chat fixtures for decision 45; the pre-agreed rule keeps the model on the slots. **Who done:** gpt-oss-20b, 18 cases, read and authors 100%, people 92% and Reply's target 87%, both 100% after fixing two fixture expectations and letting accepted message writers pass Who's confidence floor; the parser alone gets 40% of authors, so the read stays. Vitest doesn't print runners' console output here: read the results files. **Tasks, first run:** dates, changes, and events all 100%, but tasks 80%: owners flipped when someone else wrote "I"; the model's owner values are now `user`/`other` (were `me`/`them`) with a clearer prompt. **Tasks rerun:** tasks 95%, extras 7 → 1, but person 64% and dates 86%: the model left the person blank between the user and the author (code now fills in the one other person) and "end of day Friday" didn't resolve (fixed in `resolveDue`). **Tasks check:** stopped by gpt-oss-20b's daily limit after 4 of 7 cases (last night's live checks had used most of the rolling day); person and dates fixed there, but another writer's "I'll get you the draft" was still read as the user's, so code now reads the owner from the writer's own "I'll …" / "can you …" (`ownerFromText`). gpt-oss-20b is limited until its tokens refill (Rayan's app falls back to gpt-oss-120b meanwhile). **Comparison:** Qwen 3.8 got all 5 Who and 5 Tasks fixtures right with fewer tokens; gpt-oss-20b's misses there are all since fixed in code, so they likely tie; Fast stays on gpt-oss-20b to keep it out of the router's rate-limit bucket (decision 60), unless Rayan wants it moved. **Recall:** at 0.78 topic matches never fired (related notes score 0.37 to 0.74 with MiniLM); the floor is now 0.5 (decision 67): 13 of 16 selections right, no false hits. **Next, in order (ask Rayan before each Groq run):**
1. Check gpt-oss-20b's room first with one tiny call that prints only the `x-ratelimit-*` headers (as on Oct 13: a one-line `fetch` to Groq's chat endpoint with `max_tokens: 8`; never print the key). Groq doesn't report daily tokens; a 429 asking for minutes means the day's tokens are still spent.
2. ~~**Tasks check**~~: done (Oct 13 afternoon): the 7-case check and a full run held the earlier fixes; two leftover misses fixed in code (decision 68); a final run cut at 12 of 18 by the daily limit got every task and person right.
3. **Visualize**, 15 cases on gpt-oss-20b (`GLOSSLY_EVAL_LIMIT=15`, about 22 calls). The one-scale rule (decision 65) is new since the live check.
4. **Real-use record** (Step 21 item 4): `pnpm calls --router` (only 9 routings on Oct 12; more use makes it worth reading) and the call log (`pnpm calls`, counts and codes only; never copy its text anywhere). Token use per action from `llm_tokens` also replaces the estimates under "Parked" (the subscription cost basis).
5. **Record and close** (item 5): every number in `STATUS.md` and `docs/testing.md`, Step 21 marked done here and in `docs/history.md`, then Step 22.

646 unit tests pass; `pnpm typecheck` is clean.

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
- **Seen working live:** most of Phases 0 to 3 as of the Step 16 live check, and most of what came after in Step 21's end-to-end passes (Oct 12, on a throwaway profile with look-alike pages for the chat and mail apps). What wasn't run, and the fixes since that are unit-tested only, are the unchecked items in `docs/testing.md`'s backlog.
- **Not signed off:** Phase 0's per-app checks and toolbar overlap (Rayan's hand tests, `evals/capture.md`); only Notepad, Chrome, and the settings window have been tested.
- **Steps 18 to 20.3's setup (Oct 11):** built with unit tests only (the settings side of 20.1 to 20.3 also previewed in the browser with fictional data); their live checks are in the backlog under "Local models and privacy", "Tasks and events", "Design system and controls", "Tasks and Calendar", "Motion, key hints, app icon", and "Setup redesign". The overlay side of Step 20 (the panel's pickers and its window growing for them, key chips, the overlay's motion) has never been seen running.
- **Step 20.4 done** (decision 48): the local parser fixes, the shared conversation read for Who, Tasks, and Reply, the token trims, and token counts in metrics. Unit tests only; its live checks are in the backlog under "Tasks and events" and Reply's Discord items.
- **Steps 20.5 to 20.8 done** (Oct 12; decisions 49 to 62): Rayan's two Oct 12 reviews (20.5, 20.6, with pasted voice samples labeled by platform as 20.6h), the model split with the call log (20.7), and the settings cleanup with the Glass tray icon (20.8). 20.6's hotkey, typing, mouse-away, and touch checks passed live; the rest is unit tests only, with live checks in the backlog. Step 19 is closed (19.1 and 19.2 built; 19.3, Google Calendar sync, is parked). (Step 17 is closed: its metrics view landed as 17.1, the eval runners moved to Step 21, and the optional decision providers are parked.)
- **Step 21 (Oct 12 to 13):** end-to-end done, evals mostly done; see the top of this file. **Not started:** Steps 22 and 23.
- **On Rayan's machine (last known, Oct 13):** his instance was last started on the build of `eba1e42` (outside his Cursor terminal; migrations up to 9 ran; call log on). Rayan's own delete-confirm commits and the eval fixes landed after it, so **rebuild and restart** (`pnpm build`) before using or checking it: the new build moves his stored Recall floor 0.78 to 0.5 (decision 67) and carries the Tasks owner changes. His Notepad may have a `notes.txt` tab of fictional test text, and an elevated Task Manager may be minimized. Test pages live in `%TEMP%\glossly-live` (fictional: `discord-*.html`, `slack-thread.html`, `email-thread.html`, `reply-test.html`, `notes.txt`).

## Next steps, in order

Rayan reset this order on Oct 11 (decision 30): finish the features, then polish and the design pass, then one combined testing and evals step, then packaging, then the public README. Step 18 (local models and the privacy choice), 19.1 (Tasks), and 19.2 (events and the Agenda) are done; Google Calendar sync (19.3) is parked; Step 20 is done (20.1, 20.2, and 20.3 with Rayan's review fixes, decisions 41 to 47); Step 20.4, the conversation read, is done too (decision 48), and so are Steps 20.5 to 20.8 (decisions 49 to 62). **Now:** Step 21, testing and evals: end-to-end done, evals next. Each step is one or more commits; stop and hand off after each. Until Step 21, rely on unit tests and add new items to the live-check backlog in `docs/testing.md` instead of running live checks.

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

**Step 20.4: the conversation read (done, Oct 11; decision 48).** Why: Reply's local header parsing broke across apps (decision 47, then a review found more; all five fixed in chunk 1, Oct 11):
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
2. ~~The conversation read~~: done (Oct 11). `WhoReadSchema` (`messages` plus `people`) and `prompts/who.md`; `readInput` trims the window; `acceptMessages`, `splitMessages`, `readAuthor`, `authorFirst` in `people/conversation.ts`; `authorFrom` in `actions/who.ts`; Tasks awaits the read in `Capture.extractPromises` and marks per-message authors (`markedSelection` in `actions/promises.ts`); `onUsage` in `AiSdkLlm` → `llm_tokens` metrics and `features.tokens`. Tests in `people/conversation.test.ts` and `llm/llm.test.ts`. Two calls against the plan: the output cap is 400, not 250 (people rows plus 8 messages don't fit 250, and the gpt-oss fallback's reasoning tokens count against it; a cut-off answer is retried, costing a whole second call), and Tasks now waits for the read instead of running beside it (the author decides You owe or They owe and which open tasks go in the prompt). Chunk 3 reuses `splitMessages` and `isHeaderChrome` for Reply's target.
3. ~~Reply on the read~~: done (Oct 11). `Capture.startReply` awaits `readPeople` (logs `read`, `read_cached`, `messages`, `read_ms`) and uses `authorFrom`; `messagesToAnswer(text, before, me, messages)` returns the target as a suffix of the selection (`start`); `replyThread` keeps 2,000 characters before and 300 after, with `[REPLY TO THIS]`; `markOwnHeaders` also marks the read's user names; `REPLY_MAX_OUTPUT` by channel; `ChatRequest.reasoning` (streams on reasoning models). The panel's reading line is `thinking delayed` in `overlay.css`. Tests in `actions/reply.test.ts` (recipient and target from a fake read, the parser fallback, the follow-up) and `llm/llm.test.ts`. Previewed in the browser with a stub (fictional data). The low reasoning on Reply's stream is new: before, gpt-oss streamed Reply at its default (medium) effort.
4. ~~Decision 48, live checks, the eval~~: done (Oct 11). The eval's cases and scores are under Evals in `docs/testing.md`; Step 21's list names it.

**Step 20.5: Rayan's Oct 12 review fixes (done, Oct 12).** From his export and screenshots (investigated in-session; nothing of his data is in the repo):
1. ~~Style learning~~: done (decision 49). Picks vote only where every draft must choose; contractions are no longer counted (migration 8 deletes the votes); the every-5 style notes see edits by platform, the picks, and the current notes, may answer `keep`, and each note holds for one platform or everywhere.
2. ~~The overlay dropdown~~: done (decision 50). The popover already re-placed on resize; the real cause was asking for the list's full height when main could grant only part. A scrolling popover (`scrolls`) now asks for room only when neither side shows four rows (`LIST_MIN_H`). Previewed in the browser with the overlay in a frame the stub resizes like main.
3. ~~Slots on chat messages~~: done (decision 51). Tasks needs a commitment phrase, a date, or an event before the model's score can take a slot (capped at 0.45 otherwise). With no header in tier 1 on the auto path, tier 2 is read alongside the router and the slots are scored again (`authorUnknown`, `Router.rescore`) before slots 3 and 4 show. Whether Discord's tier 2 holds the header is a live check (`routed` logs `author`).
4. ~~Reply's thread~~: done (decision 52). Drafts to a selected question answered the user's own later reply, which was in the 300 characters after the selection; the thread now ends at the selected message.

**Step 20.6: Rayan's second Oct 12 review (done, Oct 12).** From a screenshot of a welcome email in Outlook on the web and his trackpad use:
1. ~~Who and Tasks evidence~~: done (decision 53).
2. ~~Context for every model call~~: done (decision 54). `describeSource` in the router, read, Tasks, Reply, Ask, and paste prompts; Ask knows today.
3. ~~Hotkey and mouse-away~~: done (decision 55). `KEY_HIDE_GRACE_MS` in `capture.ts`, `mouseAwayLimit` in `view.ts`.
4. ~~Touch input~~: done (decision 56). Raw Input in `MouseHook.cs`; `input_watch` returns `touch`. Registration checked on this machine (`touch: true`); a real trackpad test needs Rayan.
5. ~~Live checks~~: done (Oct 12). Rayan's instance was stopped for the build and restarted on it afterwards (migration 8 ran on his database then).

**Step 21: testing and evals, all in one step.** Run when Rayan is away from the machine, through a subagent (AGENTS.md). **Order matters for Groq's free tier** (Rayan, Oct 12): limits are per model (30 requests and 8,000 tokens a minute, 1,000 requests and 200,000 tokens a day), and the app and the evals share them. So the end-to-end checks run first, then the evals, most important first, smallest set first.
1. ~~**End-to-end first**~~: done (Oct 12; see the top of this file and `docs/testing.md`). The whole live-check backlog in `docs/testing.md`, including everything Steps 18 to 20.8 added; Export and Delete all data (Delete all only on a throwaway profile). Fix what it finds. Rayan's per-app hand tests in `evals/capture.md` (the Phase 0 sign-off) can happen any time; record them in `STATUS.md`.
2. ~~**Eval runners**~~: done (Oct 12). Router (now on the Decision role), Who and the conversation read, Tasks (with dates), Visualize, Recall; each takes `GLOSSLY_EVAL_LIMIT`, paces under 6,000 tokens a minute, and stops on repeated 429s or a daily limit. How to run and what each scores: Evals in `docs/testing.md`. Not run against a model yet.
3. **Evals in priority order, a minimal set first** (about 15 to 20 cases each, one at a time, stopping on repeated 429s):
   1. ~~The router~~: done (Oct 13): 100% type and slots on 20 cases; the model keeps the slots.
   2. ~~The conversation read and Who~~: done (Oct 13): read and authors 100%, people and targets 100% after fixes.
   3. Tasks: two runs done (Oct 13; dates, changes, events 100%, tasks 95%); a 7-case check of the latest fixes is left (Next, step 2).
   4. ~~The small Qwen 3.8 against gpt-oss-20b comparison~~: done (Oct 13): Qwen 10 of 10; Fast stays on gpt-oss-20b (open question below).
   5. Visualize: left (Next, step 3). The date resolver is done inside the Tasks eval (dates 100% after the "end of day" fix).
   6. ~~Recall ranking~~: done (Oct 13): the floor moved to 0.5 (decision 67), 13 of 16 right.
   Widen a set to its full size only if the minimal run leaves an open question and the day's budget allows. No other comparison evals (decision 35).
4. Read the real-use record: `pnpm calls --router` (rules vs model per content type, and which side the clicks backed) and the call log, if Rayan turned it on.
5. Record every number in `STATUS.md` and `docs/testing.md`, including the re-tuned router prompt's slot match. Pre-agreed rule: if the router's slot match stays under the rules' 90%, use the model only for `content_type` and `best_collection` and compute the people and commitment scores from rules. Who's own model call stays.

**Step 22: packaging.** `electron-builder` config (none exists yet; `pnpm dist` runs `helper:publish` then `electron-builder --win`): the helper's `helpers/windows/publish` output into `resources/helper` (`paths.ts` already looks there when packaged), `asarUnpack` for sqlite-vec's DLL and onnxruntime (`services.ts` already rewrites the sqlite-vec path to `app.asar.unpacked`), an NSIS installer with the Step 20 icon (`packages/shell-electron/resources/icon.png`, Glass; electron-builder makes the installer's `.ico`; ship `icon.png` and `icon.ico` in resources too, which `appIconPath()` and `appIcoPath()` read when packaged), and unsigned GitHub Releases as in the spec's "Distribution to testers" (with the SmartScreen note). Test the installed app end to end through a subagent, including the reminder toast that never appeared in the dev build (Windows toasts likely need the installer's Start Menu shortcut for `com.glossly.app`). Before publishing a release or making the repo public, revisit the git history note under "Things to remember".

**Step 23: the public README.** Rewrite `README.md` as the repo's front page for when it goes public: what Glossly is in one or two lines, a short demo (GIF or video) and screenshots of the pill, the bar, a few panels, and settings in light and dark, the features (from `docs/features.md`, in plain words), privacy (what stays local, Local only, keys in `safeStorage`), install from GitHub Releases (with the SmartScreen note), requirements (Windows 11; a Groq, OpenAI, or Anthropic key, or a local model), building from source, the tech stack, project layout with links to `docs/`, the roadmap (macOS later), and the license (ask Rayan which). Capture screenshots and the demo with a subagent on fictional sample data only (AGENTS.md first section), never Rayan's real data. Keep `STATUS.md` and `docs/` as the contributor docs and link them.

**Parked (Rayan: "way later" or not now):**
- Google Calendar sync (was Step 19.3; parked Oct 11). Open questions for when it comes back: OAuth with a Google Cloud project (one client for Glossly, or each user's own), what syncs which way (events only, two-way, or tasks to Google Tasks too), and blocking it under Local only (Google is off this computer). The local Agenda (decision 37) stays the source either way.
- A monthly subscription with a cap on Ask, as a third privacy choice beside All models and Local only, enforced in the model layer next to the Local only refusal. Not before packaging.
  - *Cost basis if every role ran on `gpt-6-luna` with thinking off* (Oct 12, 2026; published rates, check OpenAI's pricing page first, since one aggregator lists double): $0.10 per million input tokens, $0.50 per million output, $0.01 per million cached input; Batch and Flex are half that.
  - *Per user per month* (estimated from prompt sizes after Step 20.5, about 4 characters a token, not measured):
    - Typical day (~60 bar opens, ~35 actions; about 135K tokens in, 17K out): about $0.65, or about $0.55 with prompt caching.
    - Heavy day every day (~320 bar opens, ~290 actions; about 720K in, 92K out): about $3.50.
    - The router (a model call on every bar open) is about half the input, so skipping it when the rules are confident would cut the cost most.
  - Replace these with real numbers from the `llm_tokens` metrics (per action, Step 21) before setting a price or a cap.
- Optional decision providers for the router (the spec's Jev via OpenRouter and OpenAI Decisions, Phase 4): a `DecisionProvider` (`router/types.ts`) per API behind a setting in the Models tab. Scrapped from the plan on Oct 11; check their current docs first if it comes back, since both may have changed or no longer exist.

## Open questions for Rayan

- **Fast on Qwen 3.8 or gpt-oss-20b?** Qwen got all 10 comparison fixtures right with fewer tokens; gpt-oss-20b's misses there are all fixed in code now, so they likely tie. Moving Fast to Qwen would share the router's rate-limit bucket again (the reason for decision 60). Recommendation: keep the split. Rayan hasn't decided.
- **Debug view for testers:** new profiles now start with it off (decision 65); Rayan may want to confirm before Step 22.

Everything else he was asked is answered and recorded in `docs/decisions.md`.

## Things to remember

**Working on this machine**
- The app runs against Rayan's real data in `%APPDATA%\Glossly`. Undo every test save and remove every test row (people, commitments, voice samples, settings like `saveMode` or `identity`) a check creates.
- Rayan may be at the machine. Check `main.log`, running instances, and DB counts before driving the desktop, and don't stop his instance without asking.
- Desktop and end-to-end testing goes through a subagent (Composer or Grok in Cursor; Sonnet in Claude Code). See `docs/testing.md` for how to brief it and the `ui-drive.ps1` quirks.
- His debug view is off; diagnose pills from `main.log` (`pill shown`, `pill obstacles`, `overlay closed`, `routed`) and the `events` table.
- His Windows theme is apps light, system dark (`1,0`). Restore it after dark-mode checks.
- No `pnpm eval` unless he asks (Groq free tier, per model for the whole organisation: about 30 requests a minute, 1,000 a day, 8,000 tokens a minute, 200,000 tokens a day; cached prompt tokens don't count). Never `pnpm eval` with a key set at all: it runs every runner. Run one: `$env:GROQ_API_KEY = [Environment]::GetEnvironmentVariable('GROQ_API_KEY','User'); $env:GLOSSLY_EVAL_LIMIT='18'; pnpm exec vitest run --project evals evals/<name>.eval.ts`, then read `evals/results/<name>-<model>.json` (Vitest doesn't show the runners' console output here). Clear `GLOSSLY_EVAL_IDS`, `GLOSSLY_EVAL_MODEL`, and `GLOSSLY_EVAL_LIMIT` between runs.
- **Groq's day is rolling, not a midnight reset** (headers, Oct 13): one request comes back every 86.4 s, and tokens refill the same way. Live checks spend the same per-model budget as evals: on Oct 13 the evals hit gpt-oss-20b's daily cap because the previous night's live checks had used it. Plan the day's gpt-oss-20b use (the app's Fast role uses it too).
- Check `docs/decisions.md` for the last number right before appending: Rayan sometimes works in another session in parallel (decision 66 was taken by his delete-confirm pass while Step 21 also wrote one; the Recall one became 67).

**Conventions in the code**
- Every model call goes through `AiSdkLlm` with an `action` name and a prompt in `core/prompts/`, so the privacy choice and fallbacks apply. To decide between a model path and a code path, ask `llm.hasModel(role)` (it already follows Local only), not `settings.privacy`; read `privacy` only to word the message (decision 34). Prefer structured output with `z.enum` where options are fixed (decision 22); streamed text only where streaming matters (decision 23).
- New actions join `CONTEXTUAL_ACTIONS` or `EMPTY_ACTIONS` and get a score; never add a third visible slot.
- Schema changes are new migrations; default changes to stored settings are new `SETTINGS_MIGRATIONS` entries. Never edit a shipped one.
- Helper changes update `helpers/protocol.md`, `helpers/fixtures/`, and `core/src/helper/protocol.ts` together, plus a `--check` case when the command is deterministic.
- New push channels go in the preload's `Record<PushChannel, true>` (typecheck enforces it). The UI imports types only from `@glossly/core/api`.
- React component files export only components (Fast Refresh). Use CSS files and the `theme.css` tokens, not inline styles; new panels follow the Step 13 design (decision 13).
- Logs and metrics carry codes, counts, and timings, never selected text, keys, or site keys. The one exception is the opt-in call log (`llm_calls`, decision 61): only `AiSdkLlm`'s `onCall` writes it, only while `callLog` is on. Reading it is fine for debugging; its text is Rayan's private data (AGENTS.md).
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
- Python patch scripts mangle escapes: `'\n'` in a normal Python string becomes a real line break inside a TS string literal, and `\b` becomes a backspace character. Use raw strings (`r'''...'''`) for code with regexes or `\n`, or the Edit tool, and check the result with `cat -A`.
- Live-check subagents: give each check once, reuse test data, prefer logs and DB reads to screenshots, and make them focus the target window before every input (a pass's clicks once landed in Rayan's Claude window). Brief them from `docs/testing.md` ("Before you drive the desktop", "`scripts/ui-drive.ps1`").

**API keys**
- The app gets keys only through Settings > Models (formerly Keys; `safeStorage`, `%APPDATA%\Glossly\keys\`). Rayan's Groq key is saved there.
- `GROQ_API_KEY` is a Windows user environment variable, used only by command-line evals. Shells started before it was set don't see it: `$env:GROQ_API_KEY = [Environment]::GetEnvironmentVariable('GROQ_API_KEY','User')`. Never print or log it.

## Things Rayan has to do himself

- Hand-test capture across the apps in `evals/capture.md` (part of Step 21; any time).
- Try the real apps the Step 21 live checks only imitated with look-alike pages: Reply, Who, and Tasks in Discord, Slack, Gmail, and Outlook (including a whole quoted email chain), and a real trackpad (decision 56).
- Rebuild and restart his instance (`pnpm build`) to run the Oct 13 fixes.
- Answer the open questions above.
