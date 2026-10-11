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
| 20.2 | Oct 11 | (next) | Tasks and Calendar tabs replace Agenda: quick add with date words, sections and Completed with Undo; Month, Week (drag to create, resize, move), and Agenda; glass events; `weekStart` and `calendarView` settings; migration 6 (`completed_at`), `calendar:add`; stacked popovers (decision 40). |
| — | Oct 10 | `d9ffd97` | Docs reorganized: `HANDOFF.md` slimmed; `decisions.md`, `architecture.md`, `features.md`, `testing.md`, `history.md` added. |

Step 14 (Rayan's hand tests) has no commit yet and is now part of Step 21. Steps 20.3 to 23 are planned in `HANDOFF.md`; Google Calendar sync (19.3) is parked (reordered Oct 11; the rest of Step 17, the decision providers, is parked).
