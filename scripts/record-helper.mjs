// Runs the native helper against whatever app is in front and saves what it returns.
//
//   pnpm helper:record              read-only commands after a 3 s delay
//   pnpm helper:record --copy       also run copy_fallback (simulates Ctrl+C, restores clipboard)
//   pnpm helper:record --check      replay the deterministic fixture cases and diff the responses
//
// Recordings go to helpers/fixtures/recorded/local-*.json, which is git-ignored because it
// contains real screen text.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const fixturesDir = join(root, 'helpers', 'fixtures');
const args = new Set(process.argv.slice(2));

function helperPath() {
  const candidates =
    process.platform === 'win32'
      ? [
          join(root, 'helpers/windows/bin/Debug/net10.0-windows/glossly-helper.exe'),
          join(root, 'helpers/windows/publish/glossly-helper.exe'),
        ]
      : [join(root, 'helpers/macos/.build/release/glossly-helper')];
  const found = candidates.find((p) => existsSync(p));
  if (!found) {
    console.error('Helper binary not found. Run `pnpm helper:build` first.');
    process.exit(1);
  }
  return found;
}

function startHelper() {
  const child = spawn(helperPath(), [], { stdio: ['pipe', 'pipe', 'inherit'] });
  const pending = new Map();
  const events = [];
  let nextId = 1;
  let onReady;
  const ready = new Promise((r) => (onReady = r));

  createInterface({ input: child.stdout }).on('line', (line) => {
    const msg = JSON.parse(line);
    if ('event' in msg) {
      events.push(msg);
      if (msg.event === 'ready') onReady(msg);
      return;
    }
    const key = JSON.stringify(msg.id);
    pending.get(key)?.(msg);
    pending.delete(key);
  });

  // Unparseable requests come back with id null, so only one raw line may be in flight.
  const sendRaw = (line, id) =>
    new Promise((resolve, reject) => {
      const key = JSON.stringify(id);
      const timer = setTimeout(() => reject(new Error(`timeout: ${line.slice(0, 60)}`)), 5000);
      pending.set(key, (msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
      child.stdin.write(line + '\n');
    });

  return {
    ready,
    events,
    send: (cmd, extra = {}) => {
      const id = nextId++;
      return sendRaw(JSON.stringify({ id, cmd, ...extra }), id);
    },
    sendRaw,
    close: () => child.stdin.end(),
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function record() {
  const helper = startHelper();
  const ready = await helper.ready;
  for (let s = 3; s > 0; s--) {
    process.stdout.write(`Switch to the target app and select some text... ${s}\r`);
    await sleep(1000);
  }
  process.stdout.write('\n');

  const calls = [];
  const run = async (cmd, extra) => {
    const started = performance.now();
    const response = await helper.send(cmd, extra);
    const ms = Math.round(performance.now() - started);
    calls.push({ request: { cmd, ...extra }, response, ms });
    console.log(`${cmd.padEnd(18)} ${String(ms).padStart(4)} ms  ${response.ok ? 'ok' : response.error.code}`);
    return response;
  };

  await run('foreground');
  const sel = await run('selection');
  await run('context', { before: 500, after: 500 });
  await run('context_container', { max_chars: 8000 });
  if (sel.ok && sel.result.bounds) await run('popups_near', { bounds: sel.result.bounds, exclude_pids: [process.pid] });
  if (args.has('--copy')) await run('copy_fallback');
  helper.close();

  const outDir = join(fixturesDir, 'recorded');
  mkdirSync(outDir, { recursive: true });
  const file = join(outDir, `local-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  writeFileSync(file, JSON.stringify({ helper: ready, recorded_at: new Date().toISOString(), calls }, null, 2));
  console.log(`\nSaved ${file}`);
}

// Cases whose response does not depend on screen state.
const DETERMINISTIC = new Set([
  // baseline.json is replayed first, before mouse_hook turns the hook on.
  'baseline/before any press',
  'ping/pong',
  'errors/unknown command',
  'errors/invalid JSON',
  'errors/wrong argument type',
  'restore_focus/window closed',
  'focus_field/missing near',
  'window_corners/window closed',
  'paste/missing text',
  'popups_near/missing bounds',
  'mouse_hook/on',
  'mouse_hook/off',
  'input_watch/on',
]);

async function check() {
  const helper = startHelper();
  await helper.ready;
  let failed = 0;
  for (const file of readdirSync(fixturesDir).filter((f) => f.endsWith('.json') && f !== 'events.json')) {
    const { cases } = JSON.parse(readFileSync(join(fixturesDir, file), 'utf8'));
    for (const c of cases) {
      const name = `${file.replace('.json', '')}/${c.name}`;
      if (!DETERMINISTIC.has(name)) continue;
      const line = typeof c.request === 'string' ? c.request : JSON.stringify(c.request);
      const got = await helper.sendRaw(line, c.response.id);
      const pass = isDeepStrictEqual(got, c.response);
      if (!pass) failed++;
      console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${pass ? '' : `\n  want ${JSON.stringify(c.response)}\n  got  ${JSON.stringify(got)}`}`);
    }
  }
  helper.send('mouse_hook', { enabled: false });
  helper.close();
  process.exitCode = failed ? 1 : 0;
}

await (args.has('--check') ? check() : record());
