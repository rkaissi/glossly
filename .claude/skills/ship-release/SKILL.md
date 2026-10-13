---
name: ship-release
description: Ship a new Glossly version (0.1.1, 0.2.0, 1.0.0, 2.0.0-beta.1, any semver) as a GitHub Release that installed copies update to. Use when Rayan asks to release, ship, publish, cut, or bump a version, or to push an update to users.
---

# Ship a Glossly release

Builds the Windows installer for a new version and publishes it on GitHub Releases, where installed copies pick it up (Settings > General > Updates; decision 70). Works for any version: patch, minor, major, or a prerelease. "v1.2.0" and "1.2.0" mean the same; the script drops the v (the tag gets it back). `scripts/release.mjs` does the checks; this file is the order and the rules.

## Rules

- **Read `AGENTS.md` and `docs/HANDOFF.md` first.** Their rules apply here, above all: nothing that identifies a real person in release notes, commits, or docs, and never add Rayan's handle, name, or email anywhere new (the repo owner for the update feed is read from the git remote at build time; don't write it into files or notes).
- **Publishing is outward-facing.** Build and verify freely, but run `publish` only after Rayan approved this version and these notes in chat. A yes for one version isn't a yes for the next.
- **Versions only go up.** Installed copies update only to a higher semver than theirs. A published release is final: never replace its files (`--clobber`) or delete and recreate it, since copies may have downloaded it already. To fix a bad release, ship the next patch version.
- **A version with a `-` part** (`1.0.0-beta.1`) becomes a GitHub prerelease. Installed copies don't update to prereleases; use them for builds Rayan shares by hand.
- **Drafts don't count:** the update feed reads published releases only.
- While the repo is private, a published release is downloadable only by people with access, and installed copies see no update (the feed answers 404) until it's public. Say so when you report.

## Steps

1. **Pick the version.** Use the one Rayan named. If he didn't, show the current one (`packages/shell-electron/package.json`) and the commits since the last release (`node scripts/release.mjs notes <any-higher-version>`), suggest patch (fixes), minor (features), or major (breaking or a milestone), and ask.

2. **Check it and the repo:**
   ```bash
   node scripts/release.mjs check <version>
   ```
   It rejects a version that isn't semver, isn't higher than the current version and the latest release tag, or whose tag exists; and a branch that isn't `main`, isn't clean, or is behind `origin/main`; and a `gh` that isn't signed in. Fix what it reports (commit or ask about stray changes; never discard Rayan's work). If `gh` isn't signed in, Rayan runs `gh auth login` himself.

3. **Tests:** `pnpm test` and `pnpm typecheck` must pass. Don't run `pnpm eval` (AGENTS.md).

4. **Bump the version** in every `package.json`:
   ```bash
   node scripts/release.mjs bump <version>
   ```

5. **Build:** `pnpm dist` (publishes the C# helper, builds the app, packs the installer; a few minutes).
   - Rayan's dev instance runs from `packages/shell-electron/out`, which the build overwrites. If an `electron.exe` from this repo is running, ask him before stopping it (AGENTS.md); an installed `Glossly.exe` is unaffected.
   - In Cursor's shell, put `C:\Program Files\nodejs` first on PATH and clear `ELECTRON_RUN_AS_NODE` and `NUGET_PACKAGES` first (HANDOFF, "Agent shell quirks").
   - If electron was upgraded, `electronVersion` in `packages/shell-electron/electron-builder.config.cjs` must match the installed one exactly.

6. **Verify the output:**
   ```bash
   node scripts/release.mjs verify <version>
   ```
   It checks every `package.json` is at the version, `dist/` holds `Glossly-Setup-<version>.exe`, its `.blockmap`, and a `latest.yml` for this version, the app carries its GitHub update feed, and the installer is newer than the bump.

7. **Smoke test (recommended; required for a major version or packaging changes).** Install silently and start it on a throwaway profile, never Rayan's (decision 69):
   ```powershell
   Start-Process "packages\shell-electron\dist\Glossly-Setup-<version>.exe" -ArgumentList '/S' -Wait
   Start-Process "$env:LOCALAPPDATA\Programs\glossly\Glossly.exe" -ArgumentList "--data-dir=$env:TEMP\glossly-release-test"
   ```
   After about 10 s, `%TEMP%\glossly-release-test\logs\main.log` should show `starting {"version":"<version>"...}`, `helper ready`, and no ERROR lines. Then stop `Glossly.exe` and `glossly-helper.exe` and delete the throwaway folder. This replaces the copy installed on this machine, which is fine: it's the release. Anything that needs clicks (setup, the pill, Ask, Save) goes through a subagent (AGENTS.md; `docs/testing.md`, "Installed app"). Stop the test instance as soon as you're done: Rayan may be using the machine.

8. **Commit and push the bump:** `git commit -am "Release v<version>"` (with the attribution line from the session) and `git push`. The tag is created on `origin/main`, so main must hold the bump first.

9. **Draft the notes.** Start from `node scripts/release.mjs notes <version>` (commit subjects since the last release) and rewrite them for users: a short title line, then "New", "Fixed", and "Changed" bullets in plain words, plus the install lines below. Leave out internal work (docs, evals, refactors). No real names, handles, or private text from Rayan's data. Write the notes to a file in the session's scratchpad or `%TEMP%`, never in the repo. Keep this install section in every release:
   ```markdown
   **Install:** run `Glossly-Setup-<version>.exe`. It installs for the current user (no admin). The installer is unsigned, so SmartScreen may say "Windows protected your PC": choose More info, then Run anyway. Some antivirus apps scan new unsigned apps on first run.

   **Already installed?** Glossly updates itself: Settings > General > Updates shows "Restart to update" once it's downloaded.
   ```

10. **Ask Rayan to publish.** Show the version, what the smoke test found, and the notes, and wait for a clear yes.

11. **Publish:**
    ```bash
    node scripts/release.mjs publish <version> --notes <notes-file> --yes
    ```
    It verifies again, refuses if `main` isn't pushed, then creates the `v<version>` tag and the release with the three files (`--prerelease` for a version with a `-`).

12. **Record it:** a row in `docs/history.md` (step, date, the tag, one line), the current version and release in `docs/HANDOFF.md`'s top paragraph, and a line in `STATUS.md` if it's a milestone. Link the release as "the repo's Releases page, tag `v<version>`", not a URL with the owner's handle. Commit, push, delete the notes file, and tell Rayan: the version, the release link, what's in it, and whether installed copies will see it (public repo and not a prerelease).

## If something fails

- `check` says behind origin: `git pull --ff-only`, then rerun.
- `pnpm dist` fails at `helper:publish`: a running `glossly-helper.exe` doesn't block publishing to `helpers/windows/publish`, but a broken `NUGET_PACKAGES` does (clear it).
- `verify` says `latest.yml` isn't for the version: the build ran before the bump; run `pnpm dist` again.
- `publish` fails on `gh`: `gh auth status`; Rayan refreshes the scope with `gh auth refresh -s repo`. If the release was created but an upload failed, finish with `gh release upload v<version> <the missing file>` (no `--clobber` on files already there).
- Shipped something broken: don't touch the release; fix it, then ship the next patch version through this skill.
