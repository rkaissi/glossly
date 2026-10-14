# Glossly handoff

The current state of the build, what to do next, and what to keep in mind. Read this at the start of every session, then follow the links for detail. Update it in the same commit as each chunk of work (`AGENTS.md`).

Last updated Oct 14, 2026. **Glossly v0.1.1 is out** (the repo's Releases page, tag `v0.1.1`) and **the repo is public**, so installed copies update themselves from now on. Steps 1 to 23 of the build plan are done: the features, the design pass, testing and evals (Step 21), packaging with the installer and automatic updates (Step 22, decisions 69 to 71), and the public README with its banners and GIFs (Step 23). Everything is committed and pushed. Rayan plans to keep improving it for a few weeks, then launch publicly (Reddit and similar) as 1.0.0.

**What changed most recently (Oct 13 to 14).**
- *Releases:* v0.1.0, then v0.1.1 (Start with Windows, the window on launch, Glossly's own taskbar name and icon, horizontal bars for crowded charts). Ship new versions with the `ship-release` skill (`.claude/skills/ship-release/`, with `scripts/release.mjs`); keep 0.x as normal releases (pre-releases are skipped by the updater and by the Download link), and use `-beta.N` only for builds shared by hand.
- *Going public:* the About section, topics, and a social preview image (`docs/media/social-preview.png`); three real names in old tests were rewritten out of the git history (`git filter-repo`, `main` and `v0.1.0` force-pushed once). The rest of the early history Rayan chose to keep as is.
- *Evals and real use:* all done; the numbers are in `STATUS.md` and `docs/testing.md` ("Evals", "Real-use record").

**The first real update worked** (Oct 14: Rayan's v0.1.0 updated itself to v0.1.1, `docs/testing.md`, "Installed app"), with two problems that came from this machine's leftovers, both fixed by hand: the installer relaunched the copy in `packages\shell-electron\dist\win-unpacked` (the Start Menu shortcut pointed there), and the taskbar showed Electron (a stale dev `Electron.lnk` with Glossly's app id). The taskbar shows Glossly since (Rayan, Oct 14). **Every quit in v0.1.1 shows an Electron error box** ("database is not open"): the embeddings worker's exit handler read the store after shutdown had closed it. Fixed on `main` (`embed-host.ts`; errors while quitting are also logged as `error while quitting` instead of shown), not released yet. **Not verified yet:** the start at sign-in.

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
| `.claude/skills/ship-release/` | How to ship a new version (also used by Cursor through `.cursor/rules/ship-release.mdc`). |
| `docs/design/` | The HTML mockups Rayan approved for Step 20 (20.1 controls, 20.2 Tasks and Calendar, 20.3 hints, setup, icon, motion). The setup build follows `mockups/20-3-design-pass.html`. |

## Where things stand

- **Built:** spec Phases 0 to 3 (capture, the bar, Ask, Save, settings and setup, people and Who, Tasks and events, Reply, Recall, Search, Visualize, paste), local models and Local only, the design pass, the metrics view, the Windows installer with automatic updates, and Start with Windows. Everything a user sees is in `docs/features.md`.
- **Released:** v0.1.1 on GitHub Releases (unsigned NSIS installer, per user). Rayan runs the installed app with his real data in `%APPDATA%\Glossly`; the dev build shares that folder, so run only one of them at a time.
- **Seen working live:** most features, in the Step 16 and Step 21 live checks and the installed-app checks (`docs/testing.md`). What's still unchecked is the live-check backlog there.
- **Not signed off:** Phase 0's per-app capture checks (`evals/capture.md`, Rayan's hand tests) and the real Discord, Slack, Gmail, and Outlook apps (live checks only used look-alike pages).
- **Watch:** on Oct 14 the installed app's Save panel closed by blur about 0.6 s after opening, twice, before Rayan confirmed; he says it seems fine. If it recurs, check focus handling when a panel opens (`overlay closed {"reason":"blur","mode":"panel"}` right after `routed`).

## Next steps, in order

1. **Ship the quit fix** as v0.1.2 (`ship-release`) when Rayan says so; the update from 0.1.1 will still show the error box once, since the old code runs that quit. Afterwards check a quit from the tray shows nothing and the `Glossly` Run value points at the installed exe with `--background`, and a sign-in start shows no window. If an error box comes back, look for `error while quitting` in `main.log`.
2. **Before the public launch (Rayan's plan: a few weeks of updates, then one launch day on Reddit and elsewhere, as 1.0.0):** a license (none yet; open-source communities expect one), the social preview uploaded on GitHub (Settings > General > Social preview), the live-check backlog in `docs/testing.md`, the real chat and mail apps, and `evals/capture.md`. Ship each improvement with the `ship-release` skill.
3. **Later, from the roadmap in the README:** a code-signed installer, Google Calendar sync (parked below), macOS.

The build history (Steps 1 to 23, with commits) is in `docs/history.md`; the reasons behind each choice are in `docs/decisions.md`.

**Parked (Rayan: "way later" or not now):**
- Google Calendar sync (was Step 19.3; parked Oct 11). Open questions for when it comes back: OAuth with a Google Cloud project (one client for Glossly, or each user's own), what syncs which way (events only, two-way, or tasks to Google Tasks too), and blocking it under Local only (Google is off this computer). The local Agenda (decision 37) stays the source either way.
- A monthly subscription with a cap on Ask, as a third privacy choice beside All models and Local only, enforced in the model layer next to the Local only refusal. Not before packaging.
  - *Cost basis if every role ran on `gpt-6-luna` with thinking off* (Oct 12, 2026; published rates, check OpenAI's pricing page first, since one aggregator lists double): $0.10 per million input tokens, $0.50 per million output, $0.01 per million cached input; Batch and Flex are half that.
  - *Per user per month* (measured Oct 13 from the `llm_tokens` metrics, 142 calls; per bar open, the router's 1,166 tokens in and 47 out; per clicked action, about 1,980 in and 195 out on Rayan's mix of clicks, counting the read, and Save, Search, and Recall as free):
    - Typical day (~60 bar opens, ~35 actions; about 140K tokens in, 10K out): about $0.55 (was estimated at $0.65).
    - Heavy day every day (~320 bar opens, ~290 actions; about 950K in, 72K out): about $3.90 (was $3.50).
    - The router is half the input on a typical day and 40% on a heavy one, so skipping it when the rules are confident would still cut the cost most. Prompt caching barely shows yet (5,888 cached tokens of about 213K in).
    - Small samples: one Ask call, eight Tasks calls, and days that mixed real use with live checks.
- Optional decision providers for the router (the spec's Jev via OpenRouter and OpenAI Decisions, Phase 4): a `DecisionProvider` (`router/types.ts`) per API behind a setting in the Models tab. Scrapped from the plan on Oct 11; check their current docs first if it comes back, since both may have changed or no longer exist.

## Open questions for Rayan

- None open: the model split and the debug view are settled (decision 69).

Everything else he was asked is answered and recorded in `docs/decisions.md`.

## Things to remember

**Working on this machine**
- The app runs against Rayan's real data in `%APPDATA%\Glossly`. Undo every test save and remove every test row (people, commitments, voice samples, settings like `saveMode` or `identity`) a check creates.
- Rayan may be at the machine. Check `main.log`, running instances, and DB counts before driving the desktop, and don't stop his instance without asking.
- Desktop and end-to-end testing goes through a subagent (Composer or Grok in Cursor; Sonnet in Claude Code). See `docs/testing.md` for how to brief it and the `ui-drive.ps1` quirks.
- Ctrl+Alt+Space never registers on his machine (the Claude app holds it) and he is keeping it that way: open the bar from the pill in live checks, and ignore `hotkey could not register`.
- His debug view is off; diagnose pills from `main.log` (`pill shown`, `pill obstacles`, `overlay closed`, `routed`) and the `events` table.
- His Windows theme is apps light, system dark (`1,0`). Restore it after dark-mode checks.
- No `pnpm eval` unless he asks (Groq free tier, per model for the whole organisation: about 30 requests a minute, 1,000 a day, 8,000 tokens a minute, 200,000 tokens a day; cached prompt tokens don't count). Never `pnpm eval` with a key set at all: it runs every runner. Run one: `$env:GROQ_API_KEY = [Environment]::GetEnvironmentVariable('GROQ_API_KEY','User'); $env:GLOSSLY_EVAL_LIMIT='18'; pnpm exec vitest run --project evals evals/<name>.eval.ts`, then read `evals/results/<name>-<model>.json` (Vitest doesn't show the runners' console output here). Clear `GLOSSLY_EVAL_IDS`, `GLOSSLY_EVAL_MODEL`, and `GLOSSLY_EVAL_LIMIT` between runs.
- **Groq's day is rolling, not a midnight reset** (headers, Oct 13): one request comes back every 86.4 s, and tokens refill the same way. Live checks spend the same per-model budget as evals: on Oct 13 the evals hit gpt-oss-20b's daily cap because the previous night's live checks had used it. Plan the day's gpt-oss-20b use (the app's Fast role uses it too).
- No tool attribution in public text (Rayan, Oct 14): never write "Generated with Claude Code" or similar in release notes, PR descriptions, the README, or docs.
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
- Docs and tests use fictional people and `example.com` addresses only (AGENTS.md, first section). The current files are clean. The history was partly rewritten on Oct 13 (see Going public); what's left in early commits Rayan chose to keep. Never add anything new.

**Controls and styles (Step 20.1)**
- Plain `<button>` now has an outline (`theme.css`). A button with its own flat look (bar slots, badges, chips, icon buttons, calendar days) sets `box-shadow: none`; `overlay.css` lists the bar's. `button.danger` is filled red; `icon-btn danger` stays quiet and turns red on hover.
- Use the controls in `controls/`, never native `<select>`, date, time, or checkbox inputs. Their triggers carry `data-control`; a panel's key map should skip events from them (see `PromisesPanel`'s `onKeyDown`). Keys inside a popover never reach the panel.
- A popover closes when its anchor scrolls out of view, so open one only on a visible trigger. Popovers stack: Esc and clicks outside close only the top one, so a picker can open over the event editor. In the overlay, `RoomContext` grows the window for a popover that doesn't fit; the settings window has no provider.
- Rayan runs the installed app (`%LOCALAPPDATA%\Programs\glossly`), not the dev build; both use `%APPDATA%\Glossly`, so never start a dev instance while his runs without asking. A dev instance runs from `packages/shell-electron/out`: build elsewhere while one runs (`pnpm exec electron-vite build --outDir <scratchpad>`). To preview the settings page without the app, serve the built `renderer/` with a stub `window.glossly` that returns fictional data (how 20.1 was checked).

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

- Upload `docs/media/social-preview.png` in the repo's Settings > General > Social preview (the API can't).
- Delete `%USERPROFILE%\glossly-history-backup-2026-10-13.bundle` once he's happy with the history rewrite (it still holds the old names); re-clone or reset any other copy of the repo to the new `main`.
- Before the public launch: choose a license.
- Hand-test capture across the apps in `evals/capture.md`, and try Reply, Who, and Tasks in the real Discord, Slack, Gmail, and Outlook (including a whole quoted email chain), and a real trackpad (decision 56).
