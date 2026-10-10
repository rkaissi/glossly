# Glossly: Prototype Spec

Oct 9, 2026 · @Rayan Kaissi

## Overview and scope

Build Glossly, a Windows-first desktop prototype that ports cleanly to macOS: select text in any app and a small action pill appears (or press a hotkey), with buttons that fit what you selected. Everything you save stays on your machine and resurfaces later through a recall badge and per-person context.

The prototype tests one question: do people use the bar several times a day, and which actions do they actually click?

**In scope**

- Auto pill on selection, global hotkey, and capture of the selection plus surrounding context (Windows first, macOS second)
- Router that picks which contextual buttons to show
- Five core actions: Ask, Save, Reply, Recall, Visualize
- People layer: Who is this, What did I promise (commitments), and Reply with context
- Local storage (SQLite plus vector search), local embeddings, local usage metrics
- A small eval harness with fixture selections

**Out of scope for the prototype**

- No-selection mode (OCR of the screen around the cursor)
- Passive or always-on screen reading of any kind
- Email, calendar, or LinkedIn sync (people data comes only from what the user captures)
- Browser extension, mobile, accounts, cloud sync
- The weekly brag doc idea (tracked separately)

## Core user flow

A selection shows a small pill in under 150 ms, and the user picks an action with one click or one key.

**Triggers**

1. **Auto pill (default).** After a mouse drag-select or double-click of 3 or more words, a pill fades in near the end of the selection with Ask and Save. Nothing is sent to any model yet.
2. **Expand.** Hovering the pill, or pressing the hotkey, expands it into the full bar. The router runs now, and slots 3 and 4 plus badges fade in.
3. **Hotkey** (`Ctrl+Alt+Space` on Windows, `Cmd+Option+Space` on macOS, configurable). Opens the full bar directly and takes keyboard focus. Covers keyboard selections and apps where selection detection fails.

**Bar behavior**

- Slots 1 and 2 (Ask, Save) are always present. Slots 3 and 4 fade into fixed positions; existing buttons never move.
- Badges show when they apply: recall ("3 related") and person ("Sam: you owe 1").
- Every action is a button, selectable by mouse or keyboard.
- The pill never takes focus: it is a non-focusable window shown inactive. Clicks work without taking focus. Keyboard control starts only after the hotkey, so typing in the underlying app is never intercepted.
- The pill hides when the user types, clicks elsewhere, scrolls, or moves the mouse more than 200 px away.
- Actions that write (insert a reply, save an item, save commitments) need one confirming click or `Enter`. Saves have a 10-second undo.

**Keyboard map (after the hotkey)**

| Key | Bar | Panel |
| --- | --- | --- |
| `1` to `4` | Run the action in that slot | n/a |
| `Tab` | Open "More" | Cycle reply variants or cards |
| `Enter` | Run the highlighted action | Confirm (insert, save) |
| `Ctrl+C` | n/a | Copy the current result |
| `Esc` | Close | Back to the bar |

### Coexisting with app selection toolbars

Many apps already show their own toolbar on selection, such as Notion, Google Docs, Word, Medium, and Slack's message composer. The pill must never cover, delay, or replace them.

1. Wait about 250 ms after mouse-up before showing the pill, so the app's own toolbar renders first.
2. Then check for overlap: the helper lists popup windows and toolbar or menu elements that appeared near the selection. If one is found, place the pill on the opposite side of the selection. If both sides are taken, collapse the pill to a 12 px dot at the end of the selection.
3. Selections inside editable fields (composers, documents, code editors) also get the auto pill, placed around the app's toolbar using step 2. App toolbars are most common there, so test placement in Notion, Google Docs, and email drafts first.
4. Keep a default list of apps and sites where placement still conflicts after testing, set to hotkey-only. Match browser sites by the page-title suffix in the window title (for example "- Google Docs").
5. The pill has a "Don't show here" item that sets the current app or site to hotkey-only.
6. Per-app and per-site mode in settings: Auto pill, Hotkey only, or Off.
7. No global keyboard hooks other than the hotkey. The pill reacts only to clicks on itself.

## Architecture and stack

An Electron app with a shell-agnostic TypeScript core and one small native helper per OS. All state lives in one local SQLite file. Electron is not the bottleneck here: the overlay windows are created once and shown on demand, and visible latency is dominated by UI Automation reads and model calls.

&#91;embedded content: architecture · local components and model calls\]

Capture, routing rules, the bar, embeddings, and storage all run locally. The router's decision call and the Ask, Reply, and extraction calls are the only traffic to model providers.

| Layer | Choice | Notes |
| --- | --- | --- |
| Shell | Electron (latest stable) | Tray app. Overlay windows created once at launch, kept hidden, shown with `showInactive()` |
| UI | React + TypeScript + Vite | Renderer windows for the pill and bar, the panel, and settings |
| Core | Plain TypeScript package (`packages/core`) | Router, actions, people, storage, providers, dates. No Electron imports, so the shell can be swapped for Tauri later |
| Native helper (Windows) | C# .NET console app using FlaUI (UI Automation) | Selection, surrounding context, password and editable-field detection, toolbar overlap, focus restore, paste |
| Native helper (macOS) | Swift command-line tool using the Accessibility API | Same JSON protocol as the Windows helper |
| Global mouse events | `uiohook-napi` | Mouse-up after a drag, double-click; feeds the auto pill |
| Hotkey, clipboard, notifications, tray | Electron built-ins | `globalShortcut`, `clipboard`, `Notification`, `Tray` |
| Storage | `better-sqlite3` + `sqlite-vec` | Main process; one file in the app data directory |
| Embeddings | transformers.js with a small English model | Runs in a utility process so the UI never blocks |
| Secrets | Electron `safeStorage` | Encrypts API keys with the OS keychain (macOS) or DPAPI (Windows) |
| Charts | Vega-Lite via `vega-embed` | Rendered in the panel |
| Model calls | `fetch` with streaming | Made from the core package |

Verify every package version and native-module compatibility with the chosen Electron version before use. Swap any that are unmaintained.

**Process model**

- Main process: the Electron shell adapter, the core package, SQLite, and the helper manager
- Utility process: embeddings
- Renderer: React UI only. Talks to main through a typed IPC bridge (`contextIsolation` on, `nodeIntegration` off)
- Native helper: a long-running child process started at launch, speaking JSON lines over stdin and stdout; restarted automatically if it exits

**Repo layout (pnpm workspaces)**

```
packages/
  core/              shell-agnostic TypeScript, no electron imports
    router/  actions/  people/  store/  llm/  embed/  dates.ts  metrics.ts
    prompts/         one .md per model call
  shell-electron/    main process, windows, tray, hotkey, IPC, helper manager
  ui/                React: pill, bar, panel, settings
helpers/
  windows/           C# .NET console app (FlaUI)
  macos/             Swift command-line tool (phase 4)
  protocol.md        JSON message spec shared by both helpers
fixtures/            sample selections (JSON)
evals/               router, commitment, recall, and capture eval runners
```

## Capture layer

All OS-specific work lives in the native helper. The Electron side never calls UI Automation or the Accessibility API directly, so the macOS port is a new helper, not a rewrite. Capture must work in Chrome, Edge, Slack desktop, Discord, Outlook (web and desktop), VS Code, and Notepad before anything else gets built.

**Helper protocol (JSON lines over stdin and stdout)**

| Command | Returns |
| --- | --- |
| `selection` | Text, method, on-screen bounds, `is_editable`, `is_password` |
| `context` (`before`, `after` in characters) | Text around the selection (tier 1) |
| `context_container` (`max_chars`) | Text of the enclosing container (tier 2) |
| `foreground` | Process name, window title, window handle |
| `popups_near` (`bounds`) | Popup windows and toolbar or menu elements near the selection |
| `copy_fallback` | Selection via simulated copy, original clipboard restored |
| `restore_focus` (`handle`) | Success or error |
| `paste` (`text`) | Sets the clipboard, sends paste, restores the original clipboard |

```json
{"id": 42, "cmd": "selection"}
{"id": 42, "ok": true, "result": {"text": "...", "method": "uia", "bounds": {"x": 812, "y": 430, "w": 260, "h": 18}, "is_editable": false, "is_password": false}}
```

Document the protocol in `helpers/protocol.md` and test it with recorded fixtures, so both helpers can be checked against the same cases.

**Auto pill path**

1. `uiohook-napi` reports a mouse-up after a drag of more than 4 px, or a double-click.
2. The app asks the helper for `selection`. This path never simulates a copy.
3. Skip if the selection is empty, under 3 words, a password field, or in an app or site set to hotkey-only.
4. Wait out the rest of the 250 ms delay, call `popups_near`, and place the pill (see Coexisting with app selection toolbars).

Chromium-based browsers and Electron apps can expose limited text through UI Automation until accessibility support activates. Test each target app in Phase 0 and record the results.

**Hotkey path**

1. Record the foreground window and cursor position.
2. Call `selection`. If it is empty and the app is not blocked, call `copy_fallback`: save the clipboard, send `Ctrl+C` (`Cmd+C` on macOS), wait up to 120 ms, read, restore.
3. If still empty, open the bar in "nothing selected" state: free-form Ask and a search box over saved items.

**Surrounding context (two tiers)**

| Tier | Content | Used by | Read when |
| --- | --- | --- | --- |
| 1 | Selection plus about 500 characters on each side, and the window title | Router | On expand or hotkey |
| 2 | The enclosing container, up to 8,000 characters: a Slack message list, an email body, an article | Ask, Reply, Who is this, Promises, Save | When the user clicks an action |

Tier 2 walks up the UI Automation tree from the selection to the nearest document, list, or pane element with readable text. If the walk fails, it falls back to tier 1. Context is never stored unless the user saves, and then only a 1,000-character excerpt.

**Selection payload**

```json
{
  "text": "...",
  "context_before": "...",
  "context_after": "...",
  "source_app": "slack.exe",
  "window_title": "#design - Acme - Slack",
  "captured_at": "2026-10-09T20:41:00-04:00",
  "method": "uia | ax | copy",
  "trigger": "auto | hotkey",
  "is_editable": false,
  "foreground_handle": 123456
}
```

**Inserting text (Reply)**

Call `restore_focus` with the recorded window, then `paste` with the draft. If focus restore fails, put the draft on the clipboard and show "Copied. Paste with Ctrl+V."

**macOS helper (phase 4)**

A Swift command-line tool implementing the same protocol: `AXUIElement` for the selection, its bounds, and the surrounding text; `NSWorkspace` for the frontmost app; `CGEvent` for paste. It needs the Accessibility permission, which the global mouse hook also needs, so show one onboarding screen explaining both. The pill should be a non-activating, panel-style window; verify current Electron support for this when building.

## Router and action bar

The router answers "which two contextual buttons belong in slots 3 and 4" in under 300 ms, using free deterministic checks first and one decision-model call second.

The router runs only when the user expands the pill or presses the hotkey, never on selection alone. Its input is tier-1 context: the selection, about 500 characters on each side, and the window title.

**Step 1: deterministic features (TypeScript, under 5 ms)**

- Email addresses, @handles, and capitalized name pairs (regex)
- Exact or fuzzy match against known people and their aliases in the database
- Table shape: consistent delimiters across 3 or more lines, or numeric density above 30%
- Chat shape: lines starting with a name and timestamp, or the source app is a known messenger (Slack, Discord, Teams, WhatsApp, Messenger, Gmail, Outlook)
- Commitment phrases: "I'll", "I will", "can you", "by Friday", "let me know", dates and weekdays
- Ends with a question mark

**Step 2: decision-model call**

One call, several questions answered in parallel. Our own output contract (map it to whichever provider is used):

```json
{
  "content_type": "message_thread | single_message | table_or_numbers | article | code | contact_info | question | other",
  "authored_by_other": 0.0,
  "mentions_people": 0.0,
  "contains_commitment": 0.0,
  "best_collection": "Notes",
  "provider": "jev | openai_decisions | llm_structured | rules"
}
```

Probabilities are 0 to 1. `best_collection` is chosen from the user's existing collection names. If the call fails or exceeds 400 ms, use rules only and log it.

**Step 3: slot assignment**

| Slot | Content | Rule |
| --- | --- | --- |
| 1 | Ask | Always |
| 2 | Save to {collection} | Always; label uses `best_collection` |
| 3 and 4 | Top two contextual actions | Highest score above 0.5 |
| More (`Tab`) | Remaining contextual actions | Any score above 0.2 |

Contextual action scores:

- Reply = `authored_by_other`, only when `content_type` is a message or thread
- Who is this = 1.0 if a known person matched, else `mentions_people`
- Promises = `contains_commitment`
- Visualize = 1.0 if `table_or_numbers`, else 0

**Badges (not buttons)**

- Recall badge: shown when Recall returns at least one result above threshold (see Actions)
- Person badge: shown when a known person matched and has open commitments or a note

**Latency budget**

| Stage | Target |
| --- | --- |
| Pill visible after selection (Ask, Save) | 150 ms |
| Slots 3 and 4 filled after expand or hotkey | 400 ms |
| Badges | 500 ms |
| First streamed token of Ask or Reply | 1.0 s |

## Actions

Each action takes the selection payload plus router output and returns one panel. All model calls go through the provider traits in Model providers.

### Ask

- Input: selection, tier-2 context, top 3 recall results as optional context, and a free-text question box prefilled with nothing
- If the user presses `Enter` without typing, default question: "Explain this briefly."
- Output: streamed answer in the panel. Cite any saved items used ("From your note, Sep 18").
- No web search in v1.

### Save

- Default collections at first run: Notes, Reading, Ideas, People notes
- One `Enter` saves to the predicted collection. `Tab` cycles collections. An optional one-line "why I saved this" field appears focused; typing in it is optional.
- On save: store the item with a 1,000-character context excerpt, compute its embedding, extract entities (people, companies, products, places) with one structured LLM call, link to people when matched.
- Undo for 10 seconds.

### Reply

- Shown only for messages written by someone else
- Input: the selected message plus the surrounding thread (tier-2 context), the matched person's context (notes, open commitments, last 5 captured interactions), and 3 to 5 voice samples
- Output: 3 drafts labeled by intent, not tone (for example "Yes, Friday works", "Decline", "Ask a question")
- `Tab` cycles drafts, `Enter` inserts into the original field (see Capture layer), `Ctrl+C` copies
- Voice samples: replies the user inserted and did not edit away, plus up to 5 samples pasted in settings
- Each inserted reply is stored as an interaction with that person

### Recall

Recall is a badge, not a button. It runs whenever the router runs, on the same tier-1 context.

- Ranking order: (1) entity match on the same person, company, product, or place, (2) semantic similarity above 0.78 cosine, (3) nothing
- Show the badge only if there is at least one entity match or one semantic hit above threshold. Cap at 5 results.
- Expanded card per result: the saved snippet with the matched term highlighted, source and saved date, and a short match reason ("same person", "same product", "similar topic")
- No AI summary by default. A "Ask about these" button sends the cards to Ask.
- Card actions: open source, dismiss ("not related", logged for tuning)

### Visualize

- Shown only when `content_type` is `table_or_numbers`
- Step 1: parse the selection into a table deterministically when possible (CSV, TSV, Markdown table, aligned columns). Fall back to an LLM call that returns rows as JSON.
- Step 2: an LLM call picks a chart and returns a Vega-Lite spec that references the parsed rows. Validate it against the Vega-Lite JSON schema; on failure, show the parsed table.
- Output: chart in the panel, with "Copy as image", "Copy table as CSV", and "Save" (saves the table and spec as an item).

## People layer

People are the one thing that reliably comes back, so the prototype treats them as first-class records. In v1 every person record is built only from what the user captures through the app.

### User identity (settings)

The user enters their own name, emails, and handles at first run. Every commitment and interaction is resolved as "me" or "them" against this.

### Person resolution

1. Exact match on email or handle in `person_aliases`
2. Exact match on full name
3. Fuzzy match on name (Jaro-Winkler above 0.92) scoped to people seen in the same source app
4. No match: offer "Create person" with the detected name and email prefilled

Never merge two people automatically. Show "Is this the same Sam?" with both records and let the user confirm.

### Who is this

Panel card for the matched person:

- Name, aliases, and how you know them (user-written note)
- Open commitments, split into "You owe" and "They owe", with due dates
- Last 5 interactions (captured messages and inserted replies) with dates and source app
- Saved items that mention them
- Actions: edit note, add alias, open full record

### What did I promise

1. One structured LLM call on the selected message, with tier-2 context, returns candidate commitments.
2. Resolve due phrases to dates in the core package (see Model providers).
3. Show each candidate as a row: owner, person, text, due date. The user toggles rows on or off, then `Enter` saves the selected ones.
4. Saved commitments get an OS notification on the due date at 9:00 local time, and appear on the person badge.
5. Marking done: from the person card or the notification.

```json
{
  "commitments": [
    {
      "owner": "me | them",
      "person_name": "Sam Lee",
      "text": "send the onboarding deck",
      "due_phrase": "Friday",
      "confidence": 0.0
    }
  ]
}
```

### Reply with context

Reply (see Actions) always pulls the matched person's context. The system prompt includes open commitments in both directions, so a draft can say "Attached the deck I promised" or ask about something they owe. Drafts never invent facts that are not in the thread or the person record.

## Data model

One SQLite file with versioned migrations. Timestamps are ISO 8601 with offset. IDs are UUIDv7 strings.

```sql
CREATE TABLE collections (
  id TEXT PRIMARY KEY, name TEXT UNIQUE NOT NULL, created_at TEXT NOT NULL
);

CREATE TABLE items (
  id TEXT PRIMARY KEY,
  collection_id TEXT REFERENCES collections(id),
  kind TEXT NOT NULL,            -- selection | note | chart
  text TEXT NOT NULL,
  why TEXT,                      -- optional user note
  source_app TEXT, window_title TEXT,
  data_json TEXT,                -- table rows, chart spec, extracted fields
  created_at TEXT NOT NULL
);

CREATE TABLE entities (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,            -- person | company | product | place | other
  canonical TEXT NOT NULL,       -- normalized form used for matching
  display TEXT NOT NULL
);

CREATE TABLE item_entities (
  item_id TEXT REFERENCES items(id), entity_id TEXT REFERENCES entities(id),
  PRIMARY KEY (item_id, entity_id)
);

CREATE TABLE people (
  id TEXT PRIMARY KEY,
  entity_id TEXT UNIQUE REFERENCES entities(id),
  name TEXT NOT NULL,
  note TEXT,                     -- how you know them
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);

CREATE TABLE person_aliases (
  person_id TEXT REFERENCES people(id),
  kind TEXT NOT NULL,            -- email | handle | name
  value TEXT NOT NULL,
  UNIQUE (kind, value)
);

CREATE TABLE interactions (
  id TEXT PRIMARY KEY,
  person_id TEXT REFERENCES people(id),
  direction TEXT NOT NULL,       -- inbound | outbound
  text TEXT NOT NULL,
  source_app TEXT,
  occurred_at TEXT NOT NULL
);

CREATE TABLE commitments (
  id TEXT PRIMARY KEY,
  person_id TEXT REFERENCES people(id),
  owner TEXT NOT NULL,           -- me | them
  text TEXT NOT NULL,
  due_at TEXT,                   -- null when no date was resolved
  status TEXT NOT NULL DEFAULT 'open',  -- open | done | dropped
  source_interaction_id TEXT REFERENCES interactions(id),
  created_at TEXT NOT NULL
);

CREATE TABLE voice_samples (
  id TEXT PRIMARY KEY, text TEXT NOT NULL, origin TEXT NOT NULL, created_at TEXT NOT NULL
);

CREATE TABLE events (            -- local metrics only
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,            -- hotkey | bar_shown | action_clicked | recall_dismissed | ...
  payload_json TEXT,
  at TEXT NOT NULL
);

-- sqlite-vec virtual table, one row per item
CREATE VIRTUAL TABLE item_vectors USING vec0(item_id TEXT PRIMARY KEY, embedding FLOAT[384]);
```

The vector dimension depends on the embedding model chosen; 384 fits common small models. Store the model name in a `meta` table and re-embed on change.

Also add `models` (provider, model ID, display name, capabilities JSON, fetched at) and `settings` (key, value JSON) for role assignments and fallbacks. API keys never go in SQLite.

## Model providers

Two TypeScript interfaces in the core package isolate every provider so the router can move from a cloud decision model to a local one without touching action code. Model names live in settings, never in code.

```ts
export interface DecisionProvider {
  decide(input: SelectionContext, questions: Question[]): Promise<Decisions>;
}

export interface LlmProvider {
  stream(req: ChatRequest): AsyncIterable<string>;
  structured<T>(req: ChatRequest, schema: z.ZodType<T>): Promise<T>;
}
```

### Bring your own key

Users supply their own API keys. The app has no backend and no shared key. Every provider goes through the Vercel AI SDK (v6).

| Provider | AI SDK package | Model list endpoint | Notes |
| --- | --- | --- | --- |
| Groq | `@ai-sdk/groq` | `GET /openai/v1/models` | Free tier, no card. Suggested first key |
| OpenAI | `@ai-sdk/openai` | `GET /v1/models` | Also unlocks the OpenAI Decisions API for the router |
| Anthropic | `@ai-sdk/anthropic` | `GET /v1/models` |  |
| Google | `@ai-sdk/google` | Models list endpoint | Optional, phase 4 |
| OpenRouter | OpenRouter provider for the AI SDK | `GET /api/v1/models` | Optional, phase 4. Also the route to Jev |

Verify package names and endpoints against current docs. Adding a provider means one adapter file and entries in the capability file.

- Keys are entered in first-run setup or Settings, and each one is tested immediately with that provider's model-list call. Invalid keys are rejected with the provider's error message.
- Keys are stored encrypted with Electron `safeStorage`, one entry per provider. They are never logged and never sent anywhere except their own provider.
- Removing a key removes its models from the catalog and reassigns any role that used them.

### Model catalog

- Fetch each provider's model list when a key is added, on launch if the cache is older than 24 hours, and on "Refresh". Store results in a `models` table.
- Keep text chat models only. Drop embeddings, audio, image, moderation, and deprecated models.
- Provider list endpoints don't report capabilities consistently, so ship `packages/core/models/capabilities.json` mapping known model IDs or ID patterns to: structured output, streaming, tool use, context window, cost tier (low, medium, high), and speed tier.
- Models missing from that file show as "Untested". They can be picked by hand but are never auto-assigned.
- The picker groups models by provider and shows capability badges.

### Roles

Every model call belongs to a role, and the user picks one model per role from whatever their keys unlock. With OpenAI and Anthropic keys, for example, every chat model from both providers is available, and the user might pick GPT-6 Luna for Fast and Claude Sonnet 5.5 for Chat.

| Role | Used by | Needs | Example pick |
| --- | --- | --- | --- |
| Fast | Router fallback, entity and commitment extraction, table parsing, chart specs | Structured output, low latency, low cost | GPT-6 Luna, or a small Groq model |
| Chat | Ask, Reply | Streaming, strong writing | Claude Sonnet 5.5 |
| Decision | Router | A decision API, or the Fast model | OpenAI Decisions (OpenAI key), Jev (OpenRouter key), or "Use Fast model" |
| Embeddings | Save, Recall | Runs locally | Local model, no key needed |

- Defaults: when keys change, fill each empty role from a preference order in `capabilities.json` (Fast: the cheapest model with structured output; Chat: the highest-tier model available). Never overwrite a role the user set by hand.
- Each role has an optional fallback model. On a 429 or 5xx error, retry once on the fallback, then show the error.
- If a role's model disappears (key removed or model deprecated), switch to the default and show a one-line notice in the bar.
- Advanced settings allow a per-action override, such as Reply on a different model than Ask.

### First-run setup

Six screens. Identity and keys are required; the rest can be skipped.

1. Welcome: what the app does in three lines, plus the privacy summary.
2. You: name, emails, and handles, used to tell "me" from "them".
3. Keys: one card per provider with a "Get a key" link, a paste field, and a Test button. Groq is listed first and labeled free. At least one working key is required to continue.
4. Models: roles prefilled from defaults, each with a dropdown to change it.
5. Permissions: macOS only, the Accessibility permission with an explanation.
6. Try it: a sample paragraph and a sample chat message to select, walking through the pill, the bar, and one action.

Settings repeats screens 2 to 4 as the Profile, Keys, and Models tabs.

### Implementations, in build order

1. `RulesDecision`: deterministic features only. Always available, used as the fallback.
2. `LlmProvider` on the AI SDK with Groq, OpenAI, and Anthropic adapters. Streaming for Chat; `generateText` with `Output.object` for Fast (`generateObject` is deprecated in AI SDK v6).
3. `LlmStructuredDecision`: the router's questions answered by the Fast model. Ship this first.
4. `OpenAiDecisions` (`/v1/decisions`) and `JevDecision` (via OpenRouter) with plain `fetch`, since they don't fit the chat interface. Both are new; read current docs first.
5. Google and OpenRouter adapters.

**Structured calls**

- Every structured call has a Zod schema, which yields both the JSON Schema and the TypeScript type. Validate the response; on failure, retry once with the validation error appended, then fail gracefully.
- Keep prompts in `packages/core/prompts/*.md`, one per call, versioned in the repo.

**Date resolution**

Models return raw phrases ("Friday", "end of next week", "tomorrow 3pm"). Code in the core package resolves them against the current time and the user's time zone. Support at minimum: today, tonight, tomorrow, weekday names (next occurrence), "next {weekday}", "end of week" (Friday 17:00), "end of month", explicit dates in common formats, and times like "3pm". Anything unresolved stays null and the UI shows "No date" with an editable field. Never let the model compute a date.

## Privacy and safety rules

These are hard requirements, not preferences.

- Nothing is read from the screen unless the user mouse-selects text where the auto pill is on, or presses the hotkey. No background screen reading, keylogging, or clipboard watching.
- A selection alone never triggers a network call. The router runs only on expand or hotkey; actions run only on click.
- Context is read only at trigger time (tier 1 on expand, tier 2 on action click) and is never stored unless the user saves.
- Never capture from password fields (`IsPassword` on Windows, secure text fields on macOS). Never capture in apps on the user's block list (defaults: password managers, plus any banking apps they add).
- Embeddings, storage, and recall run locally. Text goes to a model provider only when the router runs or the user picks an action.
- A "Local only" setting disables the router's model call and uses rules only.
- API keys are encrypted with Electron `safeStorage`, never stored in plain text in the database or logs.
- Logs never contain selection or context text. Metrics in `events` store action names and timings only.
- The pill never takes focus and never intercepts keys. The only global keyboard hook is the hotkey.
- The clipboard fallback runs only on the hotkey path and must restore the user's original clipboard every time, including on errors.
- Export everything as JSON, and "Delete all data" in settings, both from day one.
- Reply never sends anything. It only inserts into the field the user was already typing in, after an explicit click or `Enter`.

## Milestones

Five phases, each ending in a demo Rayan can run himself. Do not start a phase until the previous one's checks pass.

### Phase 0: capture works

- [ ] Electron tray app with a settings window and configurable hotkey, in a pnpm monorepo with `core`, `shell-electron`, and `ui`
- [ ] C# helper implementing every protocol command, with recorded protocol fixtures
- [ ] Auto pill: mouse hook, selection read, 3-word minimum, password-field skips, 250 ms delay, toolbar-aware placement, non-focusable window
- [ ] Hotkey path with copy fallback and clipboard restore
- [ ] Debug view in the bar showing captured text, method, and tier-1 context
- [ ] Works in Chrome, Edge, Slack desktop, Discord, Outlook web, VS Code, Notepad. Record pass or fail per app, and whether tier-2 context works, in `evals/capture.md`
- [ ] No overlap with built-in selection toolbars in Notion, Google Docs, Word, and Slack's composer (checked by hand, results noted)
- [ ] Selection to pill visible under 150 ms on a mid-range laptop

### Phase 1: bar, Ask, Save

- [ ] SQLite with migrations, collections, items, events
- [ ] Rules router plus `LlmStructuredDecision`; slots fill without moving existing buttons
- [ ] Ask streams an answer; Save stores items with embeddings, entities, and undo
- [ ] Keyboard map from Core user flow works end to end
- [ ] First-run setup and settings: keys with live testing, model catalog, role assignment with fallbacks, hotkey, block list, local-only mode

### Phase 2: people layer and Reply

- [ ] User identity setup at first run
- [ ] Person resolution, Create person, alias management, confirm-merge prompt
- [ ] Who is this card
- [ ] Commitment extraction, date resolution, review-then-save, due-date notifications
- [ ] Reply with 3 intent-labeled drafts, person context, voice samples, insert into original field
- [ ] Person badge on the bar

### Phase 3: Recall and Visualize

- [ ] Recall ranking (entity match, then semantic threshold), badge, expandable cards, dismiss logging
- [ ] Visualize: deterministic table parsing, LLM fallback, validated Vega-Lite render, copy and save
- [ ] Search box over saved items when nothing is selected

### Phase 4: polish, macOS, evals

macOS work waits until a Mac is available for testing. Until then, keep everything outside `helpers/windows` OS-neutral.

- [ ] Swift helper implementing the same protocol and passing the shared protocol fixtures
- [ ] macOS Accessibility permission onboarding, non-activating pill window, `Cmd` key mappings
- [ ] Eval runners pass the thresholds in Evals and local metrics
- [ ] Optional decision providers (Jev, OpenAI Decisions) behind settings
- [ ] Local metrics view: selections per day, expand rate, action click rate per action
- [ ] Export and delete-all verified

### Distribution to testers

- Unsigned builds published as GitHub Releases, packaged with `electron-builder` (an NSIS installer on Windows; a DMG on macOS later).
- The release page explains the Windows SmartScreen warning: click "More info", then "Run anyway".
- Testers bring their own keys; the first-run setup points them to Groq's free tier.
- Auto-update on Windows through `electron-updater` and GitHub Releases, added once there are testers. macOS auto-update requires signing, so macOS testers download new versions by hand.
- Testers can export their local metrics from settings and send them back; nothing is collected automatically.

## Evals and local metrics

The evals check that each model-backed step is right often enough; the metrics check whether anyone wants it.

**Fixtures**

`fixtures/*.json`, each with a selection payload and expected outputs. Start with 60, written by hand from realistic text: 20 messages or threads, 10 with commitments in both directions, 10 tables, 10 articles or docs, 5 code snippets, 5 contact blocks. Rayan adds real examples over time (with personal details changed).

| Eval | Measures | Prototype target |
| --- | --- | --- |
| Router | `content_type` accuracy; slot 3 and 4 match expected | 85% type accuracy |
| Commitments | Precision and recall on owner + text; due date exact match | Precision 85%, recall 75% |
| Date resolver | Exact match on 50 phrases with fixed "now" | 100% on supported phrases |
| Recall | Hit at 3 on 20 seeded saved items with known related selections; false badge rate on 20 unrelated selections | Hit 80%, false badge under 10% |
| Visualize | Parsed table matches expected rows; spec validates | 90% |

Run with `cargo test -p evals` plus a script that prints a results table. Model-backed evals can be skipped in CI and run manually.

**Local metrics (stored in `events`)**

- Hotkey presses per day
- Percentage of presses that end in an action click, per action
- Time from hotkey to action click
- Recall badge shown, opened, dismissed as "not related"
- Reply drafts inserted unedited versus edited versus discarded

The settings window shows these as a simple table. Nothing is sent anywhere.

## Open decisions for Rayan

The spec uses the defaults below. Change any before handing it off.

| Decision | Default in this spec | Alternatives |
| --- | --- | --- |
| Trigger | Auto pill on mouse selection, plus hotkey | Hotkey only |
| Editable fields | Auto pill, placed around app toolbars | Hotkey only in editable areas |
| Shell | Electron | Tauri, reusing the same core and helpers, if memory use becomes a complaint |
| Default hotkey | `Ctrl+Alt+Space` (`Cmd+Option+Space` on macOS) | `Win+Shift+Space`, double-tap `Ctrl` |
| Model access | Bring your own key (Groq, OpenAI, Anthropic in v1), one model picked per role | Hosted proxy with a shared key |
| Decision model for the router | LLM structured output first, Jev or OpenAI Decisions later | Start directly with OpenAI Decisions or Jev |
| Embedding model | Small English model via transformers.js | Cloud embeddings API |
| Recall semantic threshold | 0.78 cosine | Tune after the recall eval |
| Reply variants | 3, labeled by intent | 2, or 1 plus "regenerate" |
| Product name | Glossly | Check domains and trademarks before a public build |

## Instructions for the coding agent

Build phase by phase. This first handoff covers Phases 0 and 1 only: stop after Phase 1 for review. Later phases are described so early design choices stay compatible with them.

1. Read this whole spec first. Ask before deviating from anything in Privacy and safety rules.
2. Start with Phase 0: the C# helper and the auto pill across the listed apps, before UI polish or model calls. Capture reliability and not colliding with app toolbars are the main technical risks.
3. Keep `packages/core` free of Electron imports. OS-specific work goes through the helper protocol; shell-specific work goes in `shell-electron`.
4. Check current docs for every package and API before using it. The decision APIs are only weeks old, and native modules must match the Electron version.
5. Keep model names, thresholds, and prompts out of code: settings for names and thresholds, `packages/core/prompts/*.md` for prompts.
6. Write a fixture and a test for every model-backed function and every helper command as you build it, not afterward.
7. Prefer boring, explicit code. No background services, no telemetry, no network calls outside the provider clients.
8. At the end of each phase, update `STATUS.md` with what works, what doesn't, the capture results per app, and the eval numbers.
