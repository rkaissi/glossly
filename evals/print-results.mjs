// Prints the tables for every result file the eval runs wrote to evals/results/.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = join(dirname(fileURLToPath(import.meta.url)), 'results');
const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.json')).sort() : [];
if (files.length === 0) {
  console.log('No eval results yet. Run `pnpm eval`.');
  process.exit(0);
}

const pct = (x) => `${(x * 100).toFixed(1)}%`;

for (const f of files) {
  const r = JSON.parse(readFileSync(join(dir, f), 'utf8'));
  const pass = r.type_accuracy >= r.target_type_accuracy && (r.errors ?? 0) <= r.cases * 0.1;
  console.log(`\n${r.eval} / ${r.mode}${r.model ? ` (${r.model})` : ''}  ${pass ? 'PASS' : 'FAIL'}`);
  console.table({
    'type accuracy': `${pct(r.type_accuracy)} (target ${pct(r.target_type_accuracy)})`,
    'slot 3/4 match': pct(r.slot_accuracy),
    cases: r.cases,
    'median ms': Math.round(r.median_ms * 10) / 10,
    ...(r.errors !== undefined ? { errors: r.errors, 'over 400 ms': r.over_budget } : {}),
  });
  const errorKinds = [...new Set(r.results.map((c) => c.error).filter(Boolean))];
  if (errorKinds.length) console.log(`errors (scored on the rules fallback):\n  ${errorKinds.join('\n  ')}`);
  const misses = r.results.filter((c) => !c.type_ok || !c.slots_ok);
  if (misses.length) {
    console.table(
      misses.map((c) => ({
        id: c.id,
        expected: c.expected_type,
        got: c.type_ok ? '' : c.got_type,
        'expected slots': c.expected_slots.join(', ') || '-',
        'got slots': c.slots_ok ? '' : c.got_slots.join(', ') || '-',
        ...(c.error ? { error: c.error } : {}),
      })),
    );
  }
}
