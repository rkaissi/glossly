// Visualize as the app runs it: `visualize()` on the 20 chart cases (fixtures/visualize/charts.json
// plus the table fixtures), reading the table by code when it can and by the model when it can't,
// then the structured chart pick (decision 22). Scores: answers, charts drawn, relevance against
// what each case expects, problems a reader would see, the model's calls, tokens, and time.
//
// One or two calls per case on the Fast role (gpt-oss-20b on today's Groq catalog, decision 60):
//   $env:GLOSSLY_EVAL_LIMIT='15'; pnpm exec vitest run --project evals evals/visualize.eval.ts
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { visualize, type VisualizeResult } from '@glossly/core';
import { countedLlm, errorLabel, evalModel, groqKey, limitCases, median, RateLimitStop, budgetCheck, budgetLog, resultsFile, rate, withRateLimitRetry } from './lib';
import { describeSpec, problems, relevant, render, type Expect } from './visualize-lib';

interface Case {
  id: string;
  text: string;
  expect: Expect;
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const resultsDir = join(root, 'evals', 'results');
const tableTexts = new Map(
  (JSON.parse(readFileSync(join(root, 'fixtures', 'tables.json'), 'utf8')) as { cases: { id: string; context: { text: string } }[] }).cases.map((c) => [c.id, c.context.text]),
);
const allCases: Case[] = (JSON.parse(readFileSync(join(root, 'fixtures', 'visualize', 'charts.json'), 'utf8')) as { cases: (Omit<Case, 'text'> & { text?: string })[] }).cases.map(
  (c) => ({ ...c, text: c.text ?? tableTexts.get(c.id)! }),
);
const cases = limitCases(allCases);
const modelRef = evalModel('groq:openai/gpt-oss-20b');

describe('visualize eval', () => {
  it.skipIf(!groqKey())(`visualize (${modelRef})`, async () => {
    const counted = countedLlm(modelRef);
    // visualize() turns a failed call into a note; keep the last error so a 429 can be waited out and retried.
    let lastError: unknown = null;
    const llm = Object.assign(Object.create(counted.llm) as typeof counted.llm, {
      structured: (...args: Parameters<typeof counted.llm.structured>) =>
        counted.llm.structured(...args).catch((e: unknown) => {
          lastError = e;
          throw e;
        }),
    });
    const deps = { llm, settings: () => ({ privacy: 'all' as const }) };
    const rows = [];
    let stopped: string | null = null;
    for (const [i, c] of cases.entries()) {
      // Every few cases: is what's left of the day enough for the rest (Rayan)? If not, stop here.
      const cut = budgetCheck(counted, i, cases.length - i, 2);
      if (cut) {
        stopped = cut;
        break;
      }
      let t = performance.now();
      let out: VisualizeResult;
      try {
        out = await withRateLimitRetry(
          async () => {
            lastError = null;
            const r = await visualize(deps, c.text);
            if ((lastError as { statusCode?: number } | null)?.statusCode === 429) throw lastError;
            return r;
          },
          () => {
            counted.reset();
            t = performance.now();
          },
        );
      } catch (e) {
        if (e instanceof RateLimitStop) {
          stopped = e.message;
          break;
        }
        out = { ok: false, code: 'provider', message: errorLabel(e) };
      }
      const u = counted.calls();
      const spec = out.ok ? (out.spec as Record<string, unknown> | null) : null;
      const drawn = spec ? await render(spec) : null;
      const ok = drawn && 'svg' in drawn ? drawn : null;
      const desc = ok && spec ? describeSpec(spec) : null;
      const rel = relevant(c.expect, desc);
      rows.push({
        id: c.id,
        ok: out.ok,
        code: out.ok ? null : out.code,
        table_from: out.ok ? out.table.source : null,
        chart_by: out.ok ? out.chartBy : null,
        note: out.ok ? out.note : out.message.slice(0, 80),
        kind: desc?.kind ?? null,
        render_error: drawn && 'error' in drawn ? drawn.error : null,
        problems: ok && desc && out.ok ? problems(spec!, desc, out.table, ok.marks) : [],
        relevant: rel.ok,
        why: rel.why,
        preferred: c.expect.prefer && desc ? desc.kind === c.expect.prefer : null,
        calls: u.attempts,
        ms: Math.round(performance.now() - t),
        input_tokens: u.inputTokens,
        output_tokens: u.outputTokens,
      });
      const r = rows.at(-1)!;
      console.log(`${c.id.padEnd(7)} ${r.relevant ? 'ok ' : 'BAD'} ${(r.kind ?? r.note ?? r.code ?? '').padEnd(18)} table ${r.table_from ?? '-'} calls ${r.calls} ${r.problems.join(',')} ${r.why}`);
    }
    const total = counted.total();
    const called = rows.filter((r) => r.calls > 0);
    const summary = {
      cases: rows.length,
      answered: rate(rows.map((r) => r.ok)),
      charts_drawn: rows.filter((r) => r.kind).length,
      charts_with_problems: rows.filter((r) => r.problems.length).length,
      relevance: rate(rows.map((r) => r.relevant)),
      preferred_kind: `${rows.filter((r) => r.preferred === true).length}/${rows.filter((r) => r.preferred !== null).length}`,
      model_tables: rows.filter((r) => r.table_from === 'model').length,
      median_ms: median(called.map((r) => r.ms)),
      median_output_tokens: median(called.map((r) => r.output_tokens)),
      calls: total.attempts,
      input_tokens: total.inputTokens,
      output_tokens: total.outputTokens,
      stopped,
      budget_checks: budgetLog,
    };
    console.log('visualize', JSON.stringify(summary));
    mkdirSync(resultsDir, { recursive: true });
    writeFileSync(join(resultsDir, resultsFile(`visualize-${modelRef.split('/').at(-1)}`)), JSON.stringify({ eval: 'visualize', model: modelRef, at: new Date().toISOString(), ...summary, results: rows }, null, 2));
    // A budget stop keeps the cases run so far; only a rate-limit stop fails the run.
    expect(stopped?.startsWith('budget') ? null : stopped, 'stopped on rate limits').toBeNull();
  }, 3_600_000);
});
