# Features

What each feature does today, where it lives, and how far it has been checked. "Live" means seen working in the real app on Rayan's machine; "unit" means only unit tests cover it. The live-check backlog in `docs/testing.md` lists everything still waiting for a live pass. Architecture is in `docs/architecture.md`; reasons are in `docs/decisions.md`.

Spec phase mapping: Phase 0 is Capture; Phase 1 is the bar, Ask, Save, and Settings; Phase 2 is People, Who, Tasks and events (formerly What did I promise), and Reply; Phase 3 is Recall, Search, and Visualize; Phase 4 (Windows parts) is Metrics and the evals.

## Capture (the pill, the dot, the hotkey)

**Auto pill.** Drag or double-click any non-empty, non-password selection (decision 17). The pill (200x40 DIP: menu, Ask, Save) shows below the selection end, above if something new is below, or as a dot if both sides are taken. Hover or click expands it into the bar in place.

- **Toolbar wait** (`capture/pill-wait.ts`, decision 16): checks for a new obstacle from `capture.pollStartMs` (100) after mouse-up, every `pollIntervalMs` (35). Full `pillDelayMs` (250) only in `DEFAULT_TOOLBAR_APPS` (Word, PowerPoint, Outlook, OneNote, Notion, Slack, Google Docs and Slides, Word/Outlook/Slack on the web, Medium) or apps learned in `toolbarWaits`; `shortWaitMs` (100) elsewhere. After a short-wait pill, one extra check at 250 ms learns the app or site if its own toolbar (not a menu or tooltip) showed up late. Browser pages without a site suffix are never learned.
- **Obstacles** (`capture/obstacles.ts`): the helper takes a snapshot on every left mouse-down on its own thread (`Baseline.cs`: windows screen-wide plus a column of UIA probes at 20 to 66 px above and below the press). After mouse-up, each found obstacle is `new`, `preexisting`, `tooltip`, or `covers_selection`; only `new` ones move the pill. Windows below the foreground window and click-through windows are skipped.
- **Dot**: an 18 px circle with the mark, in a 40x40 click-through window; the 80 ms cursor poll expands it on hover. `GLOSSLY_FORCE_DOT=1` (dev) forces it.
- **Hiding**: an unfocused pill or bar hides on typing, scroll, a click outside, the cursor 200 px away, or another app coming to the front (decision 18). For 500 ms after the hotkey these signals are ignored (the hotkey itself reads as keyboard activity). A focused bar closes on blur, and a click outside re-checks with the helper 120 ms later whether the bar is really in front (fixes a bar Windows never brought forward). Every close logs `overlay closed {reason, mode, focused, trigger}`.
- **Hotkey** (`Ctrl+Alt+Space`, configurable): opens the bar focused, with copy fallback for apps UIA can't read (clipboard restored). Over a visible pill it expands it. With nothing selected it reads the surroundings (`context_caret`) and opens the empty bar.
- **Per-app modes** (decision 32): block list (password managers, web vaults), hotkey-only defaults (Excel, Google Sheets, terminals, mstsc), and "Don't show here" in the menu, which stores the plain app or site name (`placeNameFor`: "Discord", "Google Docs", "Slack"; unread counts like "(214)" dropped). A name matches the app and the site in a browser. When the app is already hotkey-only the menu item is "Show here", which removes the rule. Settings > General takes the same names (or `name.exe` for the app only).
- **Cleanup**: captured text goes through `cleanText` (decision 19).
- **Debug view** (Settings > General, or the tray): method, trigger, routing stage, fallback reason, timings, pill wait, obstacles, tier-1 context. Rayan normally has it off, so diagnose from `main.log` and events.

Status: live in Notepad, Chrome, and the settings window (pill 116 to 125 ms with no toolbar expected; it never moved in pixel diffs). Not live: other apps in `evals/capture.md`, real selection toolbars, the copy-fallback branch inside the app, plain-name rules and Show here, the stuck-bar fix. Known: Edge's own selection mini-menu counts as a new obstacle; Notepad's taskbar button flashes after the tier-2 hand-off (harmless); the dot sits 4 DIP right of the mouse-up point (`placement.ts`, `anchorX + 4`) and can cover the next letter mid-word (a fix needs the last line's rect from the helper).

## The bar and keyboard map

Glossly menu, Ask, Save to {collection}, slots 3 and 4, badges (person, "N related"). The window grows rightward from a left edge picked at first paint so the widest bar (`MAX_W` 680) fits on screen. Slots 3 and 4 stay empty while a model route is in flight, then fill once; a shown button never goes away. The menu holds More (other actions above 0.2), "Don't show here (site)", Settings, and Close.

Keys (`overlay/keys.ts`): `1` to `4` run the Nth button by position (so the empty bar reads 1 Ask, 2 Search, 3 Paste snippets), `Enter` runs the highlighted one, `Tab` opens the menu with More's first item highlighted, arrows move, `Esc` closes the menu, then the panel, then the bar. Each action shows its key in a chip right of its label when General > Show keyboard shortcuts says so (Always, On hotkey (the default: a bar opened with the hotkey), or Never), decided once when the bar opens (decision 41); the keys work whenever the bar has focus.

Status: live (Step 13 and 16 checks). Not live: numbering by position.

## Ask

Streams an answer on the Chat role (`actions/ask.ts`, `prompts/ask.md`). The prompt has the asker's identity (so it doesn't treat the reader as a message's author), the selection, surrounding text with a `[SELECTION]` mark, and up to 3 saved notes from Recall ("From your note, Oct 10"). With nothing selected it uses the surroundings: "Around their cursor" with a `[CURSOR]` mark, or "What is on their screen". Asking to remember something calls the `remember` tool, which saves a note with Undo (decision 24). `Ctrl+C` copies the answer. Errors offer "Add a key", or under Local only with no local model "Use all models and ask" and "Set up a local model".

Status: live (first token about 0.7 s, remember and Undo, Local only). Not live: `Ctrl+C`, surroundings with nothing selected.

## Save and save modes

`SaveService` (`actions/save.ts`) inserts at once, then in the background embeds text plus why and extracts entities (Fast role; skipped under Local only with no local model). Undo works for 10 s (`save.undoSeconds`) plus a grace. The panel: collection chips (Tab cycles), a why field, "Saved to Notes · just now", Undo. The label takes the route's `best_collection` once when it settles. Modes (decision 15): Manual, save hotkey (toast with Undo; the default falls back to `Ctrl+Alt+Shift+S` then `Ctrl+Shift+Alt+B` if taken), Autosave (pill shows "Saved", the bar's slot 2 is "Undo save (Ns)"; moves once to the route's collection). Autosave and the save hotkey cost a model call per save (entities, and the router for the hotkey), which can hit Groq free-tier limits; the item is still saved.

Status: live (all three modes, Undo, embeddings and entities on real data).

## Recall and Search

**Recall** (`recall/recall.ts`) runs when the bar opens, on the selection only, locally: items linked to an entity named in the selection (person, company, product, place; names under 3 characters ignored) or a known person's alias, then items similar in meaning at `recall.minSimilarity` (0.78), at most 5, leaving out an item with the same text. A "N related" badge opens cards (snippet with the match marked, why it matched, collection, day, app; Copy, "Not related", "Ask about these").

**Search** is the hotkey with nothing selected: saved items by words then meaning (`recall.searchSimilarity` 0.45), people, and open commitments. Enter inserts the item when the hotkey was pressed in a text field (`canInsert`), else copies; the copy icon always copies.

Status: live (badge, cards, Ask about these, search). Not live: insert from Search.

## Paste (empty bar)

Two actions when nothing is selected (`actions/paste.ts`): **Paste snippets** (`paste_list`, no model) and **Write it for here** (`paste_summary`, one structured Chat call, `prompts/paste-compose.md`). `pasteTarget` reads the kind of spot (email, chat, document, code, other) to set how many snippets (chat 3, document 8, others 5) and the list shape (plain lines in chat, `- ` bullets elsewhere). `pasteSnippets` prefers saved items close in meaning to the text before the caret (`paste.relatedSimilarity` 0.4), else the newest from `paste.recentDays` (7). Write it for here uses only snippets that fit and shapes the text for the spot; it takes slot 4 while the user is writing. The list has List and As saved forms. The panel shows the text in an editable box first; Enter inserts through `insertText`.

Status: the earlier "Paste recent" list was live; the 16.12 rework, As saved, and Write it for here are not.

## People, Profile, and Who is this

- **Identity** (`identity` setting: name, emails, handles): setup's "You" step and the Profile tab. `isMe` matches the full name, the first name alone, first name plus last name or initial, any profile email or handle.
- **People store** (`store/people.ts`): people with aliases (name, email, handle), relationship (friend, family, colleague, professional, acquaintance, stranger, other; null = not set), note, interactions, commitments, voice samples. Rename keeps the old name as an alias; merge and delete need a confirm.
- **Resolution** (`people/resolve.ts`): email or handle alias, exact name or name alias, a first name alone against a saved full name (offered as "Is this the same X?", any app), then Jaro-Winkler above 0.92 among people seen in the same app. Never merged automatically.
- **Who is this** (`actions/who.ts`, `people/who-judge.ts`, `prompts/who.md`, decision 14): a chip per person, the card (aliases, relationship select, note, You owe / They owe, last 5 messages, saved items, Open record), "Is this the same X?", or Create person prefilled with name, email, handle, relationship, and an about line. Emails parse to a real domain ending (`people/emails.ts`), so glued words (`desk@example.comJordan`) are cut off; shared inboxes (no-reply, notifications, newsletters, scheduling) are never people. Router gives Who at least 0.9 for `contact_info` and 0.7 for a name with a phone or personal email. Answers are cached per prompt (20 entries); the local pass is not cached.
- **Person badge**: a known person in the selection with open commitments or a note ("Jordan Hale · 1 open"; several become "Jordan +2 others"). Local, exact matches only.
- **Settings > People**: open commitments across everyone, a searchable list, and the full record at `#people/<id>`.

Status: live (setup You step, Profile, Who with the model on the email fixture text, badge, People tab). Not live: the Discord fixture on a real page, real Outlook web, first-name matching, contact cards, shared-inbox and glued-domain fixes, caching, the badge collapse, relationship editing.

## Tasks and events (formerly What did I promise)

One bar action, **Tasks and events**, for promises, requests, personal todos (decision 36), and calendar events (decision 37), and two Settings tabs, **Tasks** and **Calendar** (decision 40; they replaced the Agenda tab). Internally the action id is still `promises`; tasks live in `commitments`, events in `calendar_events`.

- **One call:** one Fast structured call (`actions/promises.ts`, `prompts/extract-commitments.md`) returns `commitments` and `events`, alongside Who's people read (shared and cached). Before it, the author and the people the message names are matched to saved people (exact matches only), and their open tasks (up to 12) go into the prompt under keys (`t1`…).
- **Tasks from this message:** each row is `new`, or `same`, `done`, or `moved` with the key of an open task (`open_task` is an enum of the keys sent). Code keeps a row about an open task as that task (owner, person, text), drops a second row about the same task, and turns a `moved` without a readable new date into `same`. `same` rows start unchecked; `done` marks the task done and `moved` sets its new date on save. Due phrases come back as written; `resolveDue` (`people/dates.ts`, 60 phrases tested) turns them into dates.
- **Events from this message** (`calendar/events.ts`, `calendar/when.ts`): title, when and end as written, a length, place, and who attends. `resolveEventTime` reads ranges ("1-2pm", "11-1pm"), end times, and lengths; a day without a time is all day; a timed event without an end lasts an hour. Attendees who resolve exactly to saved people are linked. In the panel: title, day, start and end (no start is all day), place; "Already that day" lists saved events on the same day. A row with no readable day starts unchecked.
- **Already open with these people:** every other open task with the author, anyone named, Who's read, and the rows' people; Done and the date apply at once (`commitments:set-status`, `commitments:update`).
- New task rows: keep or skip, editable task, You owe / They owe, the person, the due date, and for each new person the same fields as Who's Create person (decision 33). Enter saves tasks and events together; the message is stored as an interaction with the people involved.
- **Without a usable model** (Local only without a local model, or no key; decision 34): `rulesEvents` (a day plus a meeting word, or a day and a time without deadline words; title from the meeting word and the author, place after "at" or "in") and the task patterns (`actions/promise-rules.ts`), which skip sentences that read as events, plus `matchOpenTasks`. A note says the rows came from patterns.
- **Settings > Tasks** (`settings/Tasks.tsx`, logic in `tasks-logic.ts`): quick add (a date in the text fills the chip and leaves the title), All / You owe / They owe / Todos with counts, a person filter, then Overdue, Today, each later day, No date, and Completed (closed at first, "Done yesterday"). Rows: round check (slides out, Undo bar), title edited in place, "For …" or "Waiting on …" linking to the person, a date chip on overdue rows only, and on hover a date button and a "…" menu (Open person, Delete with an inline confirm). The sidebar counts tasks due today or earlier.
- **Settings > Calendar** (`settings/Calendar.tsx`, logic in `calendar-logic.ts`, styles in `calendar.css`): Month, Week, and Agenda (a date range); Today and the arrows (in Agenda they move the range by its length); a Tasks switch; New event. Week draws events by time (overlaps side by side) with tasks in the all-day row; drag to create, resize, or move. Month shows chips, "N more" opens that day in Agenda, a click on a day adds an event. Events are tinted glass (decision 40). The editor sits beside the event: title, day, start and end (a new start keeps the length), all day, place, people, delete. Opens on the last view used; weeks start on the `weekStart` setting.
- Reminders (`reminders.ts`): tasks at `reminderHour` (9) on the due date, or at launch if missed; timed events `eventReminderMinutes` (15) before they start, until they end; all-day events from the reminder hour on their day. Up to 3 per check, events first; clicking opens Settings > Tasks (a task) or Calendar (an event). A moved date or day gets a new reminder.

Status: live (the Step 15.3 extraction, save, card). Not live: everything from Steps 19.1, 19.2, and 20.2 (open tasks, done and moved rows, events, the Tasks and Calendar tabs, todos, event reminders), the shared reader, and new-people details. **The reminder toast never appeared in the dev build** (logged `reminder shown`); likely needs the installer's Start Menu shortcut for the AppUserModelID, or Focus Assist hid it. Check in Step 22 (packaging).

## Reply

Three drafts streamed on the Chat role (`actions/reply.ts`, `prompts/reply.md`), each with a different intent, written as the user to the message's author (or a follow-up when the user wrote it). The prompt has what Glossly knows about the author (note, relationship, commitments both ways, last 5 messages), up to 5 voice samples, learned preferences, and style notes. Reply is not offered for automated mail (no-reply, receipts, shipping, codes, broadcast notices) or the user's own messages (`Features.automated`, `authorIsMe`).

- Panel: Tab cycles drafts, the pencil edits, **Write my own** (an empty fourth box), **None of these** (`N`: Shorter, Longer, More casual, More formal, Different answers, or typed words; writes three new drafts), Copy, Insert. "Add to people" opens the same form as Who (decision 33), prefilled with the author's name, email, and handle, and Colleague in work chat.
- **Insert** gives focus back and pastes. If the focused element is the read-only message, `focus_field` finds the nearest text field not above the selection (never a search or address bar) and pastes there; otherwise the clipboard with "Click the reply box and press Ctrl+V". Nothing is ever sent.
- **Learning** (decisions 27, 28; `people/reply-style.ts`, `actions/style-notes.ts`): traits measured in code (length, greeting, sign-off, exclamation marks, emoji, contractions, capitals, final period, apostrophes, dashes, ellipses, line breaks, sentence and word length, punctuation, plus kind and tone from the tags). Kinds of platform (`replyChannel`): email, work chat, messaging, other. Profile > How you write lists samples, preferences, and notes, each with Forget, and a switch for learning (`replyLearning`).
- **Cache** (decision 29): finished drafts per highlight for 30 minutes; closing the panel mid-stream lets the run finish, and reopening resumes it. Edits and the picked draft are not kept.

Status: live in the Step 15 version (three drafts in under 9 s, Insert into a test page's reply box, sample and interaction stored). Not live: `focus_field`, all learning (16.7 to 16.9), Write my own, None of these, the cache.

## Visualize

1. **Table** (`visualize/table.ts`): Markdown, TSV, CSV, semicolons, pipes, or aligned columns are parsed in code (numbers with separators, currency, %, negatives in parentheses, k/M/B; column types). Otherwise one Fast call returns rows (`prompts/visualize-table.md`).
2. **Chart** (`visualize/visualize.ts`, decision 22): one Fast call returns a chart pick (`prompts/visualize-chart.md`); `specFromChoice` writes the Vega-Lite spec, validated against the Vega-Lite schema with Ajv. No model (Local only without a local model, or no key): `rulesChoice` picks with code. Any failure shows the table with one line why.
3. **Panel** (`VisualizePanel.tsx`): `vega-embed` loaded on open (separate chunk), rendered with `vega-interpreter` because the CSP blocks `new Function`. One series in ink; several use a validated categorical palette. Chart/Table toggle, Copy as image (PNG 2x), Copy CSV, Save (a `chart` item with Undo). Results cached per text.

Status: the earlier version (model-written specs) was live after two fixes; the chart-pick rewrite and the cache are not. Known: x labels can rotate 90°; a TSV from Notepad may arrive with tabs as spaces and go to the model.

## Settings window and setup

Tabs, in two groups (decisions 39 and 40): Tasks, Calendar, People, Saved, then under Settings: Profile, Models, Privacy and data, General, Metrics (`settings/`). The window opens on Tasks. Every control is ours (`controls/`): Select, date and time pickers, segmented controls, switches, checkboxes, option cards; destructive buttons are filled red. Setup (`#setup`) has five steps: Welcome, You, Keys, Models, Try it (decision 11). The Keys step ("Choose your models") opens with the privacy choice and the local model card; Next needs a working key or local server, or Local only (which works without either).

- **Models, providers** (formerly Keys): per provider (Groq, OpenAI, Anthropic), test and save (`listModels` doubles as the test and fills the catalog), Test again, Replace, Remove (confirm). **Local model** card: Connect to Ollama or LM Studio (presets) or any address; saved only when it lists chat models; Test again, Change, Remove; warns when the address isn't this computer (decision 34).
- **Models, roles**: model and fallback per role, the Local only model (when a local server is set up), capability tags and warnings, per-action overrides, the catalog with Refresh (local server included), and the local embedding model (status and download).
- **General**: hotkey recorder, Show keyboard shortcuts (Always, On hotkey, Never), Saving (decision 15), per-app modes, Week starts on (Monday or Sunday), Debug view (a switch).
- **Saved**: every item, filter by collection, search (words, then meaning), move, copy, delete (confirm).
- **Privacy and data**: Where model calls go (All models or Local only, with what Local only uses right now; decision 34), the block list, Export, Delete all data, Reset settings (decision 10). Destructive buttons are filled red and confirm inline.
- **Metrics**: 7/30/90 days; totals, expand rate, per action clicks, click rate, median time to click; a Features table (saves by how, Related shown/opened/dismissed, Reply inserted unedited/edited/own/copied/discarded/redo, paste, search inserts, promises, failed calls and fallbacks); per day.

Status: live (setup end to end, Keys, Models, General, Data, Metrics, Profile, People; Delete all and Reset on a throwaway profile), before the Step 20.1 controls and regrouping, which were checked only in a browser preview of the built page with a stub bridge and fictional data. Not live: the privacy choice, the local model card and Local only model, Saved tab, Metrics Features table, changing the hotkey with the recorder, Export, catalog refresh errors.
