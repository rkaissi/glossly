# Agent instructions

## Never commit real people's information (most important rule)

Nothing that identifies a real person goes into this repo: not in code, tests, fixtures, comments, prompts, docs (including `docs/HANDOFF.md`), commit messages, branch names, or eval results. That means real names, email addresses, usernames and handles, phone numbers, street addresses, company-internal names, chat or server names, window titles, and message text.

- **Where real data comes from:** Rayan's screenshots and pasted text, his database and logs in `%APPDATA%\Glossly` (the model call log above all: it holds full prompts), window titles and selections seen during live checks (Discord, Slack, Gmail, Outlook tabs), and anything a subagent reports back. Treat all of it as private. Describe the case in your own words and rebuild it with made-up data, never by copying it.
- **Use fictional stand-ins:** people like Alex Morgan, Jordan Hale, Casey Lin, Maya Chen; addresses at `example.com`; companies like Acme or Northwind. Keep whatever matters for the test (a first name alone, a hyphenated surname, an unread count in a title) and change everything else.
- **The only exception** is "Rayan", meaning the project owner, used in docs to say who decided or asked for something. Don't add his full name, email, or handles anywhere new.
- **Check before every commit:** read the staged diff (`git diff --cached`) for names, emails, handles, and titles that came from real data. If you find one, already committed or not, replace it, run the tests, and tell Rayan.

## Docs

Start every session by reading `docs/HANDOFF.md`. It is the source of truth for the current state, what to do next, open questions, gotchas, and the environment quirks of this machine, and it links the other docs. Keep it updated as work lands, and keep it short: it says what changed and what's next, while the detail goes where it belongs:

- a new or changed decision → `docs/decisions.md` (append; never renumber, code cites the numbers)
- how a feature behaves, where it lives, and whether it's been checked live → `docs/features.md`
- structure, pipelines, data, migrations → `docs/architecture.md`
- test and eval results, live-check how-to, and the live-check backlog → `docs/testing.md`
- one line per step with its commit → `docs/history.md`

## Working rules

- **End-to-end and desktop testing goes through a subagent on a Cursor model** (Composer or Grok, e.g. `composer-2.5-fast` or `grok-4.7-high-fast`; in Claude Code, which has no Cursor models, a Sonnet subagent). That covers launching the app, driving windows with `scripts/ui-drive.ps1`, navigating the UI, and taking and reading screenshots. Screenshots are expensive in the main chat, so give the subagent the exact steps, what to check, and what to report (pass or fail per check, log lines, timings, paths to screenshots it judged relevant), and keep the main chat for code and decisions.
- **Never open Rayan's browsers in a live check** (Rayan, Oct 14): no Edge or Chrome window or tab, not with a separate profile, not InPrivate or as a guest, not headless. It lands in his browser and his history. Glossly only treats a page as a website (Discord, Gmail, Docs, Slack) when a real browser shows it (`isBrowser` in `capture/apps.ts`), so test pages go in the test viewer instead: `scripts/test-viewer.cjs` (a plain Electron window that keeps no profile or history) with the dev build started with `GLOSSLY_TEST_VIEWER=1`, which counts the viewer's windows as browser tabs. Open, switch, and close it with the script's own commands, not by killing processes. Otherwise use Notepad and Glossly's own windows. The built-in browser pane is inside the Claude app's window, so it can't stand in for another app (and agents must never type into Claude windows).
- Before driving the desktop, check `%APPDATA%\Glossly\logs\main.log` and the database state, and whether a Glossly instance is already running: Rayan may be using the machine at the same time, and the app uses his real data (undo any test saves).
- Commit to `main` per chunk of work, update `docs/HANDOFF.md` in the same commit, and after each committed chunk stop and give Rayan the updated handoff.
- Don't run `pnpm eval` unless Rayan asks (Groq free-tier rate limits). `pnpm test` runs unit tests only.
- Never print or log API keys or selected text. The one exception is the opt-in model call log (`llm_calls`, decision 61), which the app writes only while Rayan has it on. You may read it (`pnpm calls`) to debug, but it is his private data: never copy its text into the repo, a commit, a doc, or a test (see the first section).
- Never commit real people's information (see the first section).
- Put one-off helper scripts (patch scripts, probes, scratch builds) in the session's scratchpad or `%TEMP%`, never in the repo, and delete them when the work is done.
