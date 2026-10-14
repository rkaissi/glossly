# Build history

One line per step, so "Step N" in code comments, commits, and `STATUS.md` can be looked up. Details are in the commit (`git show <hash>`); current behavior is in `docs/features.md`. All dates 2026.

| Step | Date | Commit | What landed |
| --- | --- | --- | --- |
| 1 | Oct 9 | `ac6510a` | C# helper: mouse hook, UIA reads, focus, clipboard, JSON-lines protocol, fixtures. |
| 2 | Oct 9 | `c9f7adc` | Core: types, settings, helper client, capture gating and placement, router, store, LLM layer, embedder. |
| 3 | Oct 9 | `7f6fa2f` | Ask and Save actions, local metrics, the IPC contract. |
| 4 | Oct 9 | `f025695`, `7040442` | Core tests; 60 router fixtures and the router eval; rules tuned to 98.3% / 90%. |
| 5 | Oct 9 | `e87be71` | First LLM router eval (100% type, 61.7% slots); Groq's llama models retired; reasoning effort per model. |
| 6 | Oct 10 | `57c815c` | Electron shell: helper manager, overlay, auto and hotkey capture, routing, keys, catalog, embeddings host, tray. |
| 7 | Oct 10 | `efefdde` | Overlay UI: pill, bar, keyboard map, Ask and Save panels, debug view; `ui-drive.ps1`. |
| 8 | Oct 10 | `d99bb52` | Settings window and first-run setup; Try-it capture; forced overlay focus. Rayan ran setup; embeddings and Ask verified live. |
| 9 | Oct 10 | `83832b6` | Verified typecheck, tests, `pnpm dev`; fixed a second instance running the app, evals in `pnpm test`, Fast Refresh. |
| 10 | Oct 10 | `d1cc8ba` | No taskbar button for the overlay; `AGENTS.md`. |
| 11 | Oct 10 | `6905b5d` | `STATUS.md` and `evals/capture.md`. |
| 12.1 | Oct 10 | `0d49aa6` | The "purple oval" fix: a real dot, and only new obstacles count. |
| 12.2 | Oct 10 | `dfd8614` | Faster careful pill: helper baseline thread, cheaper `popups_near`, toolbar polling and learned waits. |
| 12.3 | Oct 10 | `7db5cd0` | Router budget 600 ms; settings migrations. |
| 12.4 | Oct 10 | `8357005` | Delete all data versus Reset settings; throwaway-profile switches. |
| 12.5 | Oct 10 | `66a16c4` | Strict Local only. |
| 12 check | Oct 10 | `607324f` | Live check; baseline probe column so static menu bars stay preexisting. |
| 13.1 to 13.3 | Oct 10 | `fd0f42d`, `a2dd2f1`, `1207141` | Acrylic spike, DWM corners via the helper; monochrome tokens and the menu-first bar; mica settings and setup. |
| 13 check | Oct 10 | `27fa510`, `cda2834` | Live check in light and dark; Glossly mark C1 (`docs/brand/`). |
| — | Oct 10 | `79fae5d` | The overlay closes when another app comes forward or Settings opens. |
| 15.1 to 15.4 | Oct 10 | `129bcfe`, `542d000`, `e590469`, `2bdaaf3` | Phase 2: identity, people layer and Who, What did I promise with reminders, Reply. |
| 15 check | Oct 10 | `7ae989f` | Live check; reminder logged but no toast in the dev build. |
| 15.5.1 to 15.5.8 | Oct 10 | `04d2d12` … `f75f5dd` | Afternoon bugs: hotkey bar stays up, slots appear once, Save's collection, no word minimum, red confirms, saved time, reply edits, Who reads with a model. |
| 15.5 review | Oct 10 | `bd27c2a` | Stuck-bar, duplicate-slot, key-remove, and Who fallback fixes. |
| 16.1 to 16.6 | Oct 10 | `2766646` … `e870739` | Phase 3: Recall and Search, paste, Save modes, Ask's remember tool, one slot rule, Visualize. |
| 16 check | Oct 10 | `29d65e2` | Live check; Visualize schema and CSP fixes. |
| — | Oct 10 | `5bf20af`, `0f58e9c`, `385a1ab` | Bar fits the screen, shared inboxes aren't people; number keys by position, insert from Search, Reply finds the reply box, Who and Visualize cached; stuck hotkey bar, text cleanup, paste As saved. |
| 16.7 | Oct 10 | `5abf50b` | Reply learns from picks and edits. |
| — | Oct 10 | `21fbd17`, `78d712d` | A first name alone asks about the saved person; Who on contact cards. |
| 16.8 | Oct 10 | `305ceff`, `211c05e` | Reply learns per relationship and kind of platform; Who's relationship and about fields. |
| 16.9 to 16.14 | Oct 10 | `b43a92d` … `32399eb` | Style measured in code, Write my own, None of these; Saved tab; surroundings with nothing selected; paste shaped for the spot; structured outputs and prompt pass; relationship editing. |
| 17.1 | Oct 10 | `631e3f0` | Metrics view covers Phases 2 and 3. |
| — | Oct 10 | `1da0d66`, `6a7e68c` | Promises shares Who's people reader; comparison evals. |
| — | Oct 10 | `e6a3c4d` … `0bca491` | Reply drafts cached per highlight; site keys keep a leading site name. |
| — | Oct 11 | `e7949b1`, (next) | Real names in unit tests and a comment replaced with fictional ones; the owner's name in test identities, fixtures, and the ui-drive sample replaced with Alex Morgan; AGENTS.md rule on real people's information. |
| — | Oct 11 | `0e7061f` | "Don't show here" stores plain names and toggles to "Show here"; one add-person form in Who, Reply, and What did I promise; Reply's unreadable Add button fixed. |
| 18 | Oct 11 | `9e15a17` | Privacy choice (All models / Local only) with a settings migration; local model server (Ollama, LM Studio) in Keys, Models, and the model layer; What did I promise by patterns without a model (decision 34). |
| 19.1 | Oct 11 | `4b8b2d0` | Tasks replaces What did I promise: open tasks with the people in the message, rows that finish or move them, personal todos, the Settings > Tasks tab (decision 36). |
| 19.2 | Oct 11 | `a5ec8a7` | Calendar events from the same Tasks and events call, migration 5, the Agenda tab (tasks and events by day), events in Search, on person cards, and in reminders (decision 37). |
| 20.1 | Oct 11 | `d308a19` | Our own controls (`ui/src/controls/`: Popover, Select, Menu, date, range, and time pickers, Segmented, Checkbox, TaskCheck, Switch, ChoiceCards) replace every native control; the spacing and size scale and filled red destructive buttons in `theme.css`; settings tabs regrouped (Keys into Models, Privacy and data) (decision 39). |
| 20.2 | Oct 11 | `1866d4e` | Tasks and Calendar tabs replace Agenda: quick add with date words, sections and Completed with Undo; Month, Week (drag to create, resize, move), and Agenda; glass events; `weekStart` and `calendarView` settings; migration 6 (`completed_at`), `calendar:add`; stacked popovers (decision 40). |
| 20.3a | Oct 11 | `f353761` | Spring motion system in `theme.css` (press, checks, tabs, lists, popovers, calendar view, overlay contents), key hints with General's Show keyboard shortcuts, the Glass app icon for the settings window; mockups kept in `docs/design/`, icon candidates in `docs/brand/` (decision 41). |
| 20.3b | Oct 11 | `c379ece` | Setup redesign: seven one-screen steps with progress dots (Welcome demo, where AI runs, add a key or connect a local model, name, models summary, search download, Try it); the Try it checklist ticks from the `setup:tried` push (decision 42). |
| 20.3c | Oct 11 | `c9eefb4` | Spacing and size check: one page rhythm for the settings tabs, 28 px row icon buttons, overlay icons at 14 or 16 px, `--h-xs` for quiet panel buttons; stale Agenda and Keys mentions fixed (decision 43). |
| 20.3d | Oct 11 | `d5c4d98` | Small fixes, Step 20 done: dot at the last line's end (helper `last_line`), short Save labels, strip only on the bare bar, Ask's spaces, Visualize labels, panels inside the source window (helper `foreground.rect`), taskbar flash, entities backfill (migration 7) (decision 44). |
| 20.3e | Oct 11 | `2737650` | Rayan's review fixes: Reply and Who on chat messages, calmer page motion, popover exits, inline confirms without the outline, quick add's date mark and clearing, week view alignment, taskbar icon (decision 45). |
| 20.3f | Oct 11 | `2144392` | Event delete morphs in place; the pill becomes the bar without Ask and Save replaying (decision 46). |
| 20.3g | Oct 11 | `7bd0691` | Reply answers only the other person: shared header parser (Discord server tags), selection trimmed to their messages, the user's headers marked, stricter prompt (decision 47). |
| 22f | Oct 13 | `f7ac771` | Rayan's first-use fixes (decision 71): starting Glossly opens its window, Start with Windows (on by default, setup and General, cleaned up on uninstall), the taskbar's name and icon (full relaunch details; a separate dev app id). |
| 23b | Oct 13 | `42c16a8` | README: a GIF per feature (Reply as the hero, Who is this, Tasks and events into the Calendar, Ask, Save and Recall, Visualize) in full-width sections instead of a table of small stills. |
| 23a | Oct 13 | `3b0c8ec` | The public README: what Glossly is, the demo GIF and screenshots (`docs/media/`, rendered headlessly from the real UI on fictional data), features, how it works, install and updates, requirements, privacy, keys, building from source, layout, stack, roadmap, docs, license (none yet). |
| 21p | Oct 13 | `78642e1` | Visualize eval on gpt-oss-20b (15 cases: chart or not all right, every chart relevant); a crowded bar chart goes horizontal in code (`crowdedLabels`). Step 21 complete. |
| 22e | Oct 13 | `cf9ecd5` | The `ship-release` skill for Claude Code and Cursor, with `scripts/release.mjs` (version checks, bump, notes, verify, publish). |
| 22d | Oct 13 | (tag `v0.1.0`) | v0.1.0 published on GitHub Releases (installer, `.blockmap`, `latest.yml`; private repo). |
| 22c | Oct 13 | `9a545a7` | Installed-app check finished (setup, the Updates group, pill and Ask, Save with an embedding, the reminder, Quit); the draft release's notes updated. The taskbar icon is still Electron's on this machine. |
| 22b | Oct 13 | `2828bd5` | Updates: electron-updater on the GitHub Releases feed, auto download, Restart to update in Settings > General and a toast, installs at the end of shutdown (decision 70); the builder config becomes `electron-builder.config.cjs` (owner from the git remote). |
| 22a | Oct 13 | `adf2980` | Packaging: `electron-builder.yml` (NSIS per user, helper and icons as resources, native modules unpacked, trimmed to x64 and English, 163 MB), `--data-dir` in any build, publisher Glossly (decision 69); installed and checked on a throwaway profile (setup, pill, Ask, Save, and the toast not yet). |
| 21o | Oct 13 | `c184197` | Step 21 closed: the real-use record read (router clicks back the model; measured tokens per action replace the cost estimates), every number in `STATUS.md` and `docs/testing.md`, Step 22's questions for Rayan in the HANDOFF. The Visualize eval is left for a day with room. |
| 21n | Oct 13 | `8bea210` | Tasks check and full rerun on gpt-oss-20b; another writer's ask is the user's or dropped, the patterns add a writer's promise the model missed (decision 68); `splitMessages` drops Slack's same-line header; the Tasks runner records the model's answer. Visualize skipped (daily limit). |
| 21m | Oct 13 | `67d9ff8` | HANDOFF brought up to date for the next session; the Recall decision renumbered 66 → 67 (Rayan's delete-confirm pass had taken 66). |
| 21l | Oct 13 | `c8df4e6` | Recall eval (local): the similarity floor goes from 0.78 to 0.5 (decision 67). |
| 21k | Oct 13 | `ae686b0` | Qwen 3.8 vs gpt-oss-20b on 5 Who and 5 Tasks fixtures: Qwen all right; Fast stays on gpt-oss-20b. |
| 21j | Oct 13 | `c90b241` | Tasks check cut by gpt-oss-20b's daily limit; another writer's own "I'll …" or "can you …" decides who owes a task. |
| 21i | Oct 13 | `0897b8d` | Tasks rerun (tasks 95%); a task with no person goes to the selection's one other person; `resolveDue` reads "end of day <day>". |
| 21h | Oct 13 | `4365ff5` | Tasks eval on gpt-oss-20b (dates, changes, events 100%; owners flipped on "I" from others); the model's owner values become user/other; picked-case runs write their own results file. |
| 21g | Oct 13 | `a0b1316` | Who and conversation-read eval on gpt-oss-20b (18 cases); accepted message writers pass Who's confidence floor. |
| 21f | Oct 13 | `fee9a16` | Router eval on Qwen 3.8 (20 cases: 100% type, 100% slots; the model keeps the slots); 10 chat fixtures updated for decision 45; runners check the day's budget every 5 cases. |
| 21e | Oct 12 | `eba1e42` | Fixes from the live checks (decision 65): debug view off for new profiles, quick add with a person, Who drops verb-like names, Visualize keeps one scale, trailing unread counts, Reply's drafts answer only the target; the HANDOFF summarizes Step 21's end-to-end results. |
| 21d | Oct 12 | `6a2184d` | End-to-end pass D (Reply and chat): the empty bar shows More's actions; an email chain's newest message is the one to answer (decision 64). |
| 21c | Oct 12 | `29c2461` | End-to-end passes B and C: `context_caret` reads the page around a Chromium reply box; the settings window redraws its mica on a theme change. |
| 21b | Oct 12 | `1f1ed11` | End-to-end pass A (Setup, settings); Tasks rows must come from the selection and the user is never the other person (decision 63). |
| 21a | Oct 12 | `aef9343` | Eval runners for Step 21: Who and the conversation read, Tasks with dates, Visualize as the app runs it, Recall on local embeddings; the router eval on the Decision role; a shared case limit, token pacing, and a stop on repeated 429s (`evals/lib.ts`). |
| 20.8a | Oct 12 | `7218353` | The search model shows its name and download size as two tags, its status on the right. |
| 20.8 | Oct 12 | `331b84d` | Settings copy cut to one line per option, Privacy and data renamed Privacy, a confirm before the call log is deleted, and the tray and helper use the Glass icon (decision 62). |
| 20.7b | Oct 12 | `914c479` | Rate-limit deadlines use the monotonic `performance.now()` instead of the wall clock; the one-hour guard from 20.7a goes (decision 60). |
| 20.7a | Oct 12 | `3779b20` | A remembered 429 more than an hour away is dropped, so a clock set back can't skip a model for longer (decision 60). |
| 20.7 | Oct 12 | `832901a` | The router gets its own model (Decision Qwen, Fast gpt-oss-20b, Chat gpt-oss-120b), 429s are remembered until retry-after, the router gets 900 ms on its fallback, the rules are recorded beside the model, and an opt-in 30-day model call log (decisions 60 and 61). |
| 20.6h | Oct 12 | `bb2ce91` | Pasted voice samples get a platform label (suggested in code, a Select in Profile, existing ones labeled once at startup), and Reply ranks them by it (decision 59). |
| 20.6g | Oct 12 | `240d051` | The pill stays while Ctrl, Alt, or Windows is held, so a slow hotkey expands it in place (helper `keyboard_activity.modifiers`; decision 58). Checked live. |
| 20.6f | Oct 12 | `b970847` | Voice samples for Reply come from the same platform and are marked with it, so an email reply is an email (decision 57). |
| 20.6e | Oct 12 | `5ecb0d5` | Step 20.6 live checks: hotkey in place, typing grace, mouse-away, touch registration (all pass). |
| 20.6d | Oct 12 | `54854ed` | Helper: touchpad, touchscreen, and pen input count as the mouse through Raw Input, so touch no longer reads as typing (decision 56). |
| 20.6c | Oct 12 | `ba769f5` | The pill waits 400 ms on keyboard activity so the hotkey expands it in place; mouse-away measures from where the cursor started (decision 55). |
| 20.6b | Oct 12 | `43d75f7` | Every model call is told where the text came from, including the kind of platform; Ask knows today (decision 54). |
| 20.6a | Oct 12 | `0ad3267` | Who and Tasks need evidence in the text: someone other than the user named; "please" alone doesn't back a task; job titles aren't names (decision 53). |
| 20.5d | Oct 12 | `722d89f` | Reply's thread ends at the selected message: later messages after the selection are left out (decision 52). |
| 20.5c | Oct 12 | `94fab09` | Slots on chat messages need evidence: Tasks needs a phrase, date, or event; tier 2 read before the slots when tier 1 has no header (`Router.rescore`; decision 51). Step 20.5 done. |
| 20.5b | Oct 12 | `5c8b8de` | Overlay lists scroll in place instead of growing the window (`scrolls`, `LIST_MIN_H`; decision 50). |
| 20.5a | Oct 12 | `6b91395` | Style learning without guessing from absence: picks vote only where every draft must choose, contractions no longer counted (migration 8 deletes the votes), style notes per platform with keep (decision 49). |
| 20.4d | Oct 11 | `6abbc1d` | Step 20.4 done: decision 48, live checks for Slack and email threads, the conversation-read eval planned for Step 21, code comments cite decision 48. |
| 20.4c | Oct 11 | `2042895` | Reply on the read: author and target from it, the reading state, the thread trimmed and marked (`[REPLY TO THIS]`), 3 voice samples of 300 characters, stable parts first, output cap by channel with low reasoning. |
| 20.4b | Oct 11 | `50de3b5` | The conversation read: Who's call also returns who wrote each message (`messages`), accepted by code (`people/conversation.ts`); a smaller input window and output cap; Tasks takes its author and per-message authors from it; token counts per call in metrics (`llm_tokens`). |
| 20.4a | Oct 11 | `b5e5631` | Local header parser fixes: no bare badges, days, or hover-timestamp lines as speakers; names with spaces; known names (`knownName`); Reply answers only what came after the user's last message. |
| — | Oct 10 | `d9ffd97` | Docs reorganized: `HANDOFF.md` slimmed; `decisions.md`, `architecture.md`, `features.md`, `testing.md`, `history.md` added. |

Step 14 (Rayan's hand tests) has no commit yet and is now part of Step 21. Step 21 is done; Steps 22 and 23 are done (see `HANDOFF.md`); Google Calendar sync (19.3) is parked (reordered Oct 11; the rest of Step 17, the decision providers, is parked).
