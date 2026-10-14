// Ships a new Glossly version (decision 70; the ship-release skill drives it). One subcommand per
// step, each failing loudly, so any agent or person runs the same checks:
//
//   node scripts/release.mjs check   <version>   is it a valid next version, and is the repo ready?
//   node scripts/release.mjs bump    <version>   writes it into every package.json
//   node scripts/release.mjs notes   <version>   commit subjects since the last release, to draft notes from
//   node scripts/release.mjs tag     <version>   pushes the tag v<version>; GitHub Actions builds it into a draft release
//   node scripts/release.mjs status  <version>   is the draft built, and with which files?
//   node scripts/release.mjs download <version> <dir>   the draft's installer, for the smoke test
//   node scripts/release.mjs verify  <version>   are the installer, .blockmap, and latest.yml built for it? (CI runs this)
//   node scripts/release.mjs publish <version> --notes <file> --yes
//                                                 adds the notes to the draft and publishes it (only after Rayan's go)
//
// Releases are built by .github/workflows/release.yml on GitHub's Windows machines, not on this PC
// (decision 73), so every release is built from the tagged commit in a clean checkout.
//
// Versions are semver ("0.1.1", "1.0.0", "2.3.0-beta.1"); a leading v is dropped ("v0.1.1" is 0.1.1), and the tag is v<version>.
// A version with a "-" part is published as a prerelease, which installed copies don't update to.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SHELL = join(root, 'packages/shell-electron');
const DIST = join(SHELL, 'dist');
/** Every package.json that carries the version; the app reports the shell's (`app.getVersion()`). */
const PACKAGES = ['package.json', 'packages/core/package.json', 'packages/ui/package.json', 'packages/shell-electron/package.json'];
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?$/;

const fail = (msg) => {
  console.error(`✗ ${msg}`);
  process.exit(1);
};
const ok = (msg) => console.log(`✓ ${msg}`);
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }).trim();
const tryRun = (cmd, args) => {
  try {
    return { ok: true, out: run(cmd, args) };
  } catch (e) {
    return { ok: false, out: String(e.stderr ?? e.message ?? '') };
  }
};

function parse(v) {
  const m = SEMVER.exec(v ?? '');
  if (!m) return null;
  return { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] ? m[4].split('.') : [] };
}

/** Semver precedence: negative when a < b. A prerelease sorts before its release. */
function compare(a, b) {
  const x = parse(a);
  const y = parse(b);
  for (const k of ['major', 'minor', 'patch']) if (x[k] !== y[k]) return x[k] - y[k];
  if (!x.pre.length || !y.pre.length) return y.pre.length - x.pre.length;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i];
    const q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    const pn = /^\d+$/.test(p);
    const qn = /^\d+$/.test(q);
    if (pn && qn && +p !== +q) return +p - +q;
    if (pn !== qn) return pn ? -1 : 1;
    if (p !== q) return p < q ? -1 : 1;
  }
  return 0;
}

const readJson = (rel) => JSON.parse(readFileSync(join(root, rel), 'utf8'));
const currentVersion = () => readJson('packages/shell-electron/package.json').version;

/** The highest v<semver> tag, local or on origin. */
function latestTag() {
  const local = run('git', ['tag', '--list', 'v*']).split('\n');
  const remote = tryRun('git', ['ls-remote', '--tags', '--refs', 'origin', 'v*']);
  const fromRemote = remote.ok ? remote.out.split('\n').map((l) => l.split('refs/tags/')[1]) : [];
  const versions = [...local, ...fromRemote].filter(Boolean).map((t) => t.replace(/^v/, '')).filter((v) => parse(v));
  return versions.sort(compare).at(-1) ?? null;
}

function requireVersion(raw) {
  if (!raw) fail('Give the version, like 0.1.1.');
  // The v belongs to the tag; package.json and the update feed take the bare version.
  const v = raw.replace(/^v/i, '');
  if (!parse(v)) fail(`"${raw}" isn't a semver version (major.minor.patch, optionally -prerelease).`);
  return v;
}

function check(v) {
  const latest = latestTag();
  const current = currentVersion();
  if (compare(v, current) <= 0) fail(`${v} must be higher than the current version ${current}: installed copies only update to a higher version.`);
  if (latest && compare(v, latest) <= 0) fail(`${v} must be higher than the latest release v${latest}.`);
  ok(`${v} is a valid next version (current ${current}, latest release ${latest ? `v${latest}` : 'none'})${parse(v).pre.length ? '; it will be a prerelease' : ''}`);
  if (run('git', ['tag', '--list', `v${v}`])) fail(`The tag v${v} already exists locally.`);
  const remoteTag = tryRun('git', ['ls-remote', '--tags', 'origin', `refs/tags/v${v}`]);
  if (remoteTag.ok && remoteTag.out) fail(`The tag v${v} already exists on origin.`);
  const branch = run('git', ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (branch !== 'main') fail(`Release from main (on ${branch}).`);
  if (run('git', ['status', '--porcelain'])) fail('The working tree has changes: commit or stash them first.');
  const fetched = tryRun('git', ['fetch', '-q', 'origin', 'main']);
  if (!fetched.ok) fail('git fetch origin main failed; check the network and credentials.');
  const [behind, ahead] = run('git', ['rev-list', '--left-right', '--count', 'origin/main...HEAD']).split(/\s+/).map(Number);
  if (behind) fail(`main is ${behind} commit(s) behind origin/main: pull first.`);
  ok(`on main, clean${ahead ? `, ${ahead} commit(s) to push` : ', in sync with origin'}`);
  const gh = tryRun('gh', ['auth', 'status']);
  if (!gh.ok) fail('gh is not signed in: run `gh auth login` (needs the repo scope).');
  if (!/repo/.test(gh.out)) console.warn('! gh may lack the repo scope; `gh auth refresh -s repo` if publishing fails.');
  ok('gh is signed in');
}

function bump(v) {
  for (const rel of PACKAGES) {
    const path = join(root, rel);
    const text = readFileSync(path, 'utf8');
    const next = text.replace(/("version":\s*")[^"]+(")/, `$1${v}$2`);
    if (next === text && !text.includes(`"version": "${v}"`)) fail(`No version field in ${rel}.`);
    writeFileSync(path, next);
  }
  ok(`version ${v} written to ${PACKAGES.length} package.json files`);
}

function notes() {
  const latest = latestTag();
  const range = latest ? [`v${latest}..HEAD`] : [];
  const log = run('git', ['log', '--no-merges', '--pretty=format:- %s', ...range]);
  console.log(`Commits since ${latest ? `v${latest}` : 'the start'} (subjects only; rewrite them for users, no real names):\n`);
  console.log(log || '(none)');
}

function files(v) {
  return [`Glossly-Setup-${v}.exe`, `Glossly-Setup-${v}.exe.blockmap`, 'latest.yml'].map((f) => join(DIST, f));
}

function verify(v) {
  if (currentVersion() !== v) fail(`packages/shell-electron/package.json says ${currentVersion()}, not ${v}: run bump first.`);
  for (const rel of PACKAGES) if (readJson(rel).version !== v) fail(`${rel} isn't at ${v}.`);
  const [exe, blockmap, latest] = files(v);
  for (const f of [exe, blockmap, latest]) if (!existsSync(f)) fail(`Missing ${f.slice(root.length + 1)}: run \`pnpm dist\`.`);
  const mb = statSync(exe).size / 1e6;
  if (mb < 50) fail(`The installer is only ${mb.toFixed(0)} MB; the build looks incomplete.`);
  const yml = readFileSync(latest, 'utf8');
  if (!new RegExp(`^version: ${v.replace(/\./g, '\\.')}$`, 'm').test(yml)) fail(`latest.yml isn't for ${v}: rebuild with \`pnpm dist\`.`);
  if (!yml.includes(`Glossly-Setup-${v}.exe`)) fail('latest.yml points at another installer.');
  const feed = join(DIST, 'win-unpacked/resources/app-update.yml');
  if (!existsSync(feed) || !/provider: github/.test(readFileSync(feed, 'utf8'))) fail('The app has no GitHub update feed (resources/app-update.yml).');
  if (statSync(exe).mtimeMs < statSync(join(SHELL, 'package.json')).mtimeMs) fail('The installer is older than the version bump: run `pnpm dist` again.');
  ok(`built: Glossly-Setup-${v}.exe (${mb.toFixed(0)} MB), its .blockmap, latest.yml, and the update feed`);
}

/** Pushes the tag for a bumped, pushed version; the release workflow builds from it. */
function tag(v) {
  if (currentVersion() !== v) fail(`packages/shell-electron/package.json says ${currentVersion()}, not ${v}: bump, commit, and push first.`);
  for (const rel of PACKAGES) if (readJson(rel).version !== v) fail(`${rel} isn't at ${v}.`);
  if (run('git', ['status', '--porcelain'])) fail('The working tree has changes: commit them first.');
  run('git', ['fetch', '-q', 'origin', 'main']);
  if (run('git', ['rev-parse', 'HEAD']) !== run('git', ['rev-parse', 'origin/main'])) fail('HEAD must be origin/main: push (or pull) first, so the tag is on what GitHub has.');
  if (run('git', ['tag', '--list', `v${v}`])) fail(`The tag v${v} already exists locally.`);
  run('git', ['tag', '-a', `v${v}`, '-m', `Glossly ${v}`]);
  run('git', ['push', 'origin', `v${v}`]);
  ok(`pushed v${v}; GitHub Actions is building it (\`gh run watch\`, or \`node scripts/release.mjs status ${v}\`)`);
}

/** The release for v<version> as GitHub has it, or null. */
function release(v) {
  const r = tryRun('gh', ['release', 'view', `v${v}`, '--json', 'isDraft,isPrerelease,assets,url']);
  return r.ok ? JSON.parse(r.out) : null;
}

function requireDraft(v) {
  const r = release(v);
  if (!r) fail(`No release for v${v} yet: the workflow may still be building (\`gh run list --workflow release.yml\`).`);
  const names = r.assets.map((a) => a.name);
  const want = files(v).map((f) => basename(f));
  const missing = want.filter((n) => !names.includes(n));
  if (missing.length) fail(`The release lacks ${missing.join(', ')}.`);
  const exe = r.assets.find((a) => a.name === want[0]);
  if (exe.size < 50e6) fail(`The installer is only ${(exe.size / 1e6).toFixed(0)} MB; the build looks incomplete.`);
  return r;
}

function status(v) {
  const r = requireDraft(v);
  ok(`v${v} is ${r.isDraft ? 'a draft' : 'published'}${r.isPrerelease ? ' (prerelease)' : ''} with ${r.assets.map((a) => a.name).join(', ')}`);
}

function download(v, args) {
  const dir = args[0];
  if (!dir) fail('Give a folder to download the installer into.');
  requireDraft(v);
  run('gh', ['release', 'download', `v${v}`, '--pattern', `Glossly-Setup-${v}.exe`, '--dir', dir, '--clobber']);
  ok(`downloaded ${join(dir, `Glossly-Setup-${v}.exe`)}`);
}

function publish(v, args) {
  const i = args.indexOf('--notes');
  const notesFile = i >= 0 ? args[i + 1] : null;
  if (!notesFile || !existsSync(notesFile)) fail('Pass --notes <file> with the release notes.');
  if (!args.includes('--yes')) fail('Publishing is outward-facing: pass --yes only after Rayan said to publish this version.');
  const r = requireDraft(v);
  if (!r.isDraft) fail(`v${v} is already published; a published release is final (ship the next version instead).`);
  const latest = parse(v).pre.length ? [] : ['--latest'];
  run('gh', ['release', 'edit', `v${v}`, '--notes-file', notesFile, '--draft=false', ...latest]);
  ok(`published ${release(v)?.url ?? `v${v}`}`);
}

const [cmd, version, ...rest] = process.argv.slice(2);
const steps = { check, bump, notes, tag, status, download, verify, publish };
if (!steps[cmd]) fail(`Usage: node scripts/release.mjs <${Object.keys(steps).join('|')}> <version>`);
const v = requireVersion(version);
steps[cmd](v, rest);
