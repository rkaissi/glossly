# Agent instructions

Start every session by reading `docs/HANDOFF.md`. It is the source of truth for the current state, what to do next, open questions, gotchas, and the environment quirks of this machine, and it links the other docs. Keep it updated as work lands, and keep it short: it says what changed and what's next, while the detail goes where it belongs:

- a new or changed decision → `docs/decisions.md` (append; never renumber, code cites the numbers)
- how a feature behaves, where it lives, and whether it's been checked live → `docs/features.md`
- structure, pipelines, data, migrations → `docs/architecture.md`
- test and eval results, live-check how-to, and the live-check backlog → `docs/testing.md`
- one line per step with its commit → `docs/history.md`

## Working rules

- **End-to-end and desktop testing goes through a subagent on a Cursor model** (Composer or Grok, e.g. `composer-2.5-fast` or `grok-4.7-high-fast`; in Claude Code, which has no Cursor models, a Sonnet subagent). That covers launching the app, driving windows with `scripts/ui-drive.ps1`, navigating the UI, and taking and reading screenshots. Screenshots are expensive in the main chat, so give the subagent the exact steps, what to check, and what to report (pass or fail per check, log lines, timings, paths to screenshots it judged relevant), and keep the main chat for code and decisions.
- Before driving the desktop, check `%APPDATA%\Glossly\logs\main.log` and the database state, and whether a Glossly instance is already running: Rayan may be using the machine at the same time, and the app uses his real data (undo any test saves).
- Commit to `main` per chunk of work, update `docs/HANDOFF.md` in the same commit, and after each committed chunk stop and give Rayan the updated handoff.
- Don't run `pnpm eval` unless Rayan asks (Groq free-tier rate limits). `pnpm test` runs unit tests only.
- Never print or log API keys or selected text.
- Never commit real people's names, email addresses, or handles. In `docs/HANDOFF.md` and other docs, use fictional people and example addresses (for example Alex Morgan, `alex.morgan@example.com`).
