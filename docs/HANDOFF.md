# Glossly handoff

The current state of the build, what to do next, and what to keep in mind. Read this at the start of every session, then follow the links for detail. Update it in the same commit as each chunk of work (`AGENTS.md`).

Last updated Oct 11, 2026: plain-name per-app rules with a "Show here" toggle, and one add-person form (decisions 32 and 33; not checked live). 434 unit tests pass; `pnpm typecheck` is clean.

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
- **Seen working live:** most of Phases 0 to 3 as of the Step 16 live check. Everything built after it (Steps 16.7 to 16.14, 17.1, and the fixes since, including Oct 11's) has unit tests only. `docs/testing.md` has the backlog as a checklist.
- **Not signed off:** Phase 0's per-app checks and toolbar overlap (Rayan's hand tests, `evals/capture.md`); only Notepad, Chrome, and the settings window have been tested.
- **Not started:** the rest of Step 17, the eval run, packaging, local models, todos and calendar, polish.
- **On Rayan's machine (last known):** an older build than `HEAD` is running against his real data; his Notepad has a few unsaved sample tabs from earlier checks. Check before assuming anything (see "Before you drive the desktop" in `docs/testing.md`).

## Next steps, in order

Rayan set this order on Oct 10 (decision 30). Each step is one or more commits; stop and hand off after each.

**0. The live-check backlog (recommended first, when Rayan is away from the machine).** A lot landed without a live pass. Run the checklist in `docs/testing.md` through a subagent, fix what it finds, and tick items off. Rayan hasn't asked for this explicitly; confirm the timing with him.

**Step 14 (any time, Rayan):** the per-app hand tests in `evals/capture.md`. Fix what they turn up (apps where UIA reads nothing, pill placement next to real toolbars, additions to `DEFAULT_HOTKEY_ONLY`) and record results in `STATUS.md`. This is Phase 0's sign-off and can run alongside everything else.

**Step 17 (rest): Phase 4, Windows parts.** Skip the Swift helper and macOS onboarding.
- Eval runners for every eval in the spec's table: commitments extraction, the date resolver (`resolveDue` already has 60 unit cases; an eval adds model-in-the-loop phrases), Recall ranking, Visualize, the router (exists), and people extraction built from the Who fixtures in `core/src/people/who-judge.test.ts`. Follow `evals/router.eval.ts`: skip without `GROQ_API_KEY`, retry on 429, fail on a high error rate, write to `evals/results/`, print with `print-results.mjs`. Don't run them (Step 18 does).
- Optional decision providers behind settings (the spec names Jev and OpenAI Decisions): implement `DecisionProvider` (`router/types.ts`), add them to the Models tab. Check their current docs first; they may have changed or not exist.
- Export and Delete all data checked live (Delete all was checked on a throwaway profile; Export never).

**Step 18: one eval run.** Rayan approved exactly one `pnpm eval` run once Step 17 is done. Record every number in `STATUS.md` and `docs/testing.md`, including the re-tuned router prompt's slot match. Pre-agreed rule: if the router's slot match stays under the rules' 90%, use the model only for `content_type` and `best_collection` and compute the people and commitment scores from rules. Who's own model call is separate and stays. Optionally run the comparison evals (`GLOSSLY_COMPARE=1`) if Rayan agrees to the extra calls.

**Step 19: packaging.** `electron-builder` config (none exists yet; `pnpm dist` runs `helper:publish` then `electron-builder --win`): the helper's `helpers/windows/publish` output into `resources/helper` (`paths.ts` already looks there when packaged), `asarUnpack` for sqlite-vec's DLL and onnxruntime (`services.ts` already rewrites the sqlite-vec path to `app.asar.unpacked`), an NSIS installer, unsigned GitHub Releases as in the spec's "Distribution to testers" (with the SmartScreen note). Test the installed app end to end through a subagent, including the reminder toast that never appeared in the dev build (Windows toasts likely need the installer's Start Menu shortcut for `com.glossly.app`). Use the Step 22 icon if it exists, else the tray mark.

**Step 20: local models, and privacy as a choice.** Add a local provider (an OpenAI-compatible endpoint such as Ollama or LM Studio) to the catalog and roles. Replace the Local only checkbox with a choice: **On this computer** or **Use my API key**. On this computer, calls go to the local model when one is configured, else they're refused as today (decision 12). The General tab says which is active in one sentence. Leave room for a third choice (the parked subscription).

**Step 21: todos and calendar, in the app first.** A selection can become a todo or a calendar event, detected like commitments (one structured call, the user confirms, due phrases through `resolveDue`), stored locally, shown in Search and on a person's card, with reminders through the commitment notifier. Add the action ids to `CONTEXTUAL_ACTIONS` with a score (see "Routing and slots" in `docs/architecture.md`); `LaterPanel` covers an action whose panel isn't built yet. **Google Calendar and reminders sync is the second half**, only after the local list works.

**Step 22: polish.** Motion on the bar and panels (the current fades are the floor), one accent color on the glass (lifts the "no accent" part of decision 13), and a real app icon for window, tray, and installer. Keep it quiet: no illustration pass, no second theme.

**Parked (Rayan: "way later"):** a monthly subscription with a cap on Ask, as a third choice beside "Use my API key", enforced in the model layer next to the Local only refusal. Not before packaging, not in the same step as local models.

**Small things to pick up when nearby:**
- The dot sits 4 DIP right of the mouse-up point and can cover the next letter (`placement.ts`, `anchorX + 4`); a real fix needs the last line's rect from the helper.
- Long Save labels truncate at the 172 px slot cap ("Save to People not…").
- The "Nothing selected…" strip stays above the paste panel and is truncated there.
- Ask's Markdown rendering once joined "at 10 a.m." into "at10a.m.." (`markdown.ts`).
- Visualize's x labels sometimes rotate 90°.
- Panels can extend past the source window onto whatever is below.
- Notepad's taskbar button flashes after the tier-2 hand-off (a Windows refusal in `Focus.cs`; harmless).
- Items saved under Local only never get entities (decision 12); a backfill when it's turned off would be easy if Rayan wants it.

## Open questions for Rayan

1. **Who is this and What did I promise:** keep them as two actions (they now share one people read), or merge them? Left separate pending his call.
2. **The live-check backlog:** run it before Step 17, or keep building and check later?
3. **Comparison evals in Step 18:** run them alongside the router eval (about 300 more Groq calls), or skip?

Everything else he was asked has been answered and is recorded in `docs/decisions.md`.

## Things to remember

**Working on this machine**
- The app runs against Rayan's real data in `%APPDATA%\Glossly`. Undo every test save and remove every test row (people, commitments, voice samples, settings like `saveMode` or `identity`) a check creates.
- Rayan may be at the machine. Check `main.log`, running instances, and DB counts before driving the desktop, and don't stop his instance without asking.
- Desktop and end-to-end testing goes through a subagent (Composer or Grok in Cursor; Sonnet in Claude Code). See `docs/testing.md` for how to brief it and the `ui-drive.ps1` quirks.
- His debug view is off; diagnose pills from `main.log` (`pill shown`, `pill obstacles`, `overlay closed`, `routed`) and the `events` table.
- His Windows theme is apps light, system dark (`1,0`). Restore it after dark-mode checks.
- No `pnpm eval` unless he asks (Groq free tier: 1,000 requests a day, 8,000 tokens a minute, per model).

**Conventions in the code**
- Every model call goes through `AiSdkLlm` with an `action` name and a prompt in `core/prompts/`, so Local only and fallbacks apply. Prefer structured output with `z.enum` where options are fixed (decision 22); streamed text only where streaming matters (decision 23).
- New actions join `CONTEXTUAL_ACTIONS` or `EMPTY_ACTIONS` and get a score; never add a third visible slot.
- Schema changes are new migrations; default changes to stored settings are new `SETTINGS_MIGRATIONS` entries. Never edit a shipped one.
- Helper changes update `helpers/protocol.md`, `helpers/fixtures/`, and `core/src/helper/protocol.ts` together, plus a `--check` case when the command is deterministic.
- New push channels go in the preload's `Record<PushChannel, true>` (typecheck enforces it). The UI imports types only from `@glossly/core/api`.
- React component files export only components (Fast Refresh). Use CSS files and the `theme.css` tokens, not inline styles; new panels follow the Step 13 design (decision 13).
- Logs and metrics carry codes, counts, and timings, never selected text, keys, or site keys.
- Nothing destructive without an inline confirm and a red control. People are never created or merged without a confirm.
- Keep everything outside `helpers/windows` OS-neutral (macOS later).
- Docs and tests use fictional people and `example.com` addresses only.

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

- Hand-test capture across the apps in `evals/capture.md` (Step 14).
- Answer the open questions above.
