// Reads the model call log (decision 61) and the router's rules-vs-model record from the app's
// database, read-only. The log holds the user's own text: read it to debug, never copy it into
// the repo, a commit, or a doc (AGENTS.md).
//
//   pnpm calls                       last 20 calls, one line each
//   pnpm calls --action who -n 5     one action's calls
//   pnpm calls --full -n 1           with the prompt and the answer
//   pnpm calls --fallbacks           only calls that fell back or failed
//   pnpm calls --router              rules vs model agreement per content type (metrics, no text)
//   pnpm calls --db <path>           another database (default %APPDATA%\Glossly\glossly.db)
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const path = value('--db', join(process.env.APPDATA ?? '', 'Glossly', 'glossly.db'));
const db = new DatabaseSync(path, { readOnly: true });

if (flag('--router')) {
  const rows = db
    .prepare("SELECT payload_json FROM events WHERE kind = 'router_done' AND payload_json LIKE '%\"agree\"%'")
    .all()
    .map((r) => JSON.parse(r.payload_json));
  const byType = {};
  for (const r of rows) {
    const t = (byType[r.content_type] ??= { routings: 0, slots_agree: 0, type_agree: 0, fell_back: 0 });
    t.routings++;
    if (r.agree) t.slots_agree++;
    if (r.type_agree) t.type_agree++;
    if (r.fell_back) t.fell_back++;
  }
  console.table(byType);
  const clicks = db
    .prepare("SELECT payload_json FROM events WHERE kind = 'action_clicked' AND payload_json LIKE '%\"in_rules\"%'")
    .all()
    .map((r) => JSON.parse(r.payload_json))
    .filter((c) => !['ask', 'save'].includes(c.action));
  const tally = { clicks: clicks.length, model_only: 0, rules_only: 0, both: 0, neither: 0 };
  for (const c of clicks) tally[c.in_model && c.in_rules ? 'both' : c.in_model ? 'model_only' : c.in_rules ? 'rules_only' : 'neither']++;
  console.log('Clicked actions in slots 3 and 4 (or More):', tally);
  process.exit(0);
}

if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'llm_calls'").get()) {
  console.log('This database has no call log yet: start a build with decision 61 once (migration 9).');
  process.exit(0);
}

const where = [];
const params = [];
if (value('--action')) {
  where.push('action = ?');
  params.push(value('--action'));
}
if (flag('--fallbacks')) where.push("(fallback_from IS NOT NULL OR status != 'ok')");
const n = Math.min(500, Number(value('-n', '20')) || 20);
const rows = db
  .prepare(`SELECT * FROM llm_calls ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY at DESC, rowid DESC LIMIT ?`)
  .all(...params, n);

if (rows.length === 0) console.log('No calls logged. Turn on Settings > Privacy > Keep a log of model calls.');
for (const r of rows.reverse()) {
  const from = r.fallback_from ? ` (fallback from ${r.fallback_from})` : '';
  const tokens = `${r.input_tokens ?? '?'} in${r.cached_tokens ? ` (${r.cached_tokens} cached)` : ''}, ${r.output_tokens ?? '?'} out${r.reasoning_tokens ? ` (${r.reasoning_tokens} reasoning)` : ''}`;
  console.log(`${r.at}  ${r.action.padEnd(14)} ${r.model}${from}  ${r.status}${r.error ? ` ${r.error}` : ''}  ${r.ms} ms  ${tokens}`);
  if (flag('--full')) console.log(`--- prompt ---\n${r.prompt}\n--- answer ---\n${r.response ?? '(none)'}\n`);
}
