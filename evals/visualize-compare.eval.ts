// Visualize: the model writing a whole Vega-Lite spec (v1, before Step 16.13) against the model
// picking a chart from enums of the table's columns while code writes the spec (v2, now). Same
// table, same model, same input for both. Measures, per method: calls that worked, specs that
// validated, charts that render with marks, charts with a problem a reader would see (mixed
// scales on one axis, crowded labels, wrong order, design overrides), relevance against what
// each case expects, latency, and output tokens. Writes evals/results/visualize-compare.json and
// a side-by-side HTML page of every chart.
//
// Calls the model (about 45 calls). Runs only with GROQ_API_KEY and GLOSSLY_COMPARE=1:
//   $env:GLOSSLY_COMPARE='1'; pnpm exec vitest run --project evals evals/visualize-compare.eval.ts
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as vega from 'vega';
import { compile } from 'vega-lite';
import { describe, expect, it } from 'vitest';
import {
  buildChartPrompt,
  chartChoiceSchema,
  inferTypes,
  isValidSpec,
  parseTable,
  specFromChoice,
  toTable,
  VisualizeTableSchema,
  type FieldType,
  type ParsedTable,
} from '@glossly/core';
import { chartV1 } from './legacy/visualize-v1';
import { countedLlm, errorLabel, groqKey, median, withRateLimitRetry } from './lib';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const resultsDir = join(root, 'evals', 'results');
const modelRef = process.env.GLOSSLY_EVAL_MODEL ?? 'groq:qwen/qwen3.8-27b';
const run = Boolean(groqKey()) && process.env.GLOSSLY_COMPARE === '1';

interface Expect {
  chart: boolean | 'either';
  kinds?: string[];
  prefer?: string;
  x?: string | null;
  measures?: string[];
  single?: boolean;
  order?: 'data';
  split?: boolean;
}
interface Case {
  id: string;
  text: string;
  expect: Expect;
}

const tableTexts = new Map(
  (JSON.parse(readFileSync(join(root, 'fixtures', 'tables.json'), 'utf8')) as { cases: { id: string; context: { text: string } }[] }).cases.map((c) => [c.id, c.context.text]),
);
const cases: Case[] = (JSON.parse(readFileSync(join(root, 'fixtures', 'visualize', 'charts.json'), 'utf8')) as { cases: (Omit<Case, 'text'> & { text?: string })[] }).cases.map(
  (c) => ({ ...c, text: c.text ?? tableTexts.get(c.id)! }),
);
const tablePrompt = readFileSync(join(root, 'packages', 'core', 'prompts', 'visualize-table.md'), 'utf8');

/** The app's light-mode chart config (VisualizePanel's chartConfig with the light tokens), so both methods render as the app would. */
const CONFIG = {
  background: '#ffffff',
  font: 'Segoe UI, sans-serif',
  view: { stroke: null },
  axis: { labelColor: '#4b4b4b', titleColor: '#4b4b4b', labelFontSize: 11, titleFontSize: 11, titleFontWeight: 500, gridColor: 'rgba(0,0,0,0.08)', domainColor: 'rgba(0,0,0,0.16)', tickColor: 'rgba(0,0,0,0.16)', labelLimit: 120 },
  legend: { labelColor: '#4b4b4b', titleColor: '#4b4b4b', labelFontSize: 11, titleFontSize: 11, orient: 'top', symbolType: 'circle' },
  range: { category: ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6', '#e34948'] },
  mark: { color: '#0d0d0d' },
  bar: { cornerRadiusEnd: 4, stroke: 'transparent' },
  line: { strokeWidth: 2 },
  point: { size: 64, filled: true },
  area: { opacity: 0.85 },
};

interface Desc {
  kind: string;
  x: string | null;
  measures: string[];
  split: string | null;
  /** The category axis keeps the rows' order (sort: null). */
  dataOrder: boolean;
}

type Enc = { field?: string; type?: string; sort?: unknown; value?: unknown; axis?: { labelAngle?: number } | null };

/** What a spec draws, read the same way for both methods. */
function describeSpec(spec: Record<string, unknown>): Desc {
  const m = spec.mark as string | { type?: string } | undefined;
  const mark = typeof m === 'string' ? m : (m?.type ?? 'unknown');
  const enc = (spec.encoding ?? {}) as Record<string, Enc | undefined>;
  const fold = ((spec.transform as { fold?: string[] }[] | undefined) ?? []).find((t) => t.fold)?.fold ?? null;
  let kind = mark === 'circle' || mark === 'square' ? 'point' : mark;
  let cat = enc.x;
  let val = enc.y;
  if (mark === 'bar' && enc.x?.type === 'quantitative' && enc.y && enc.y.type !== 'quantitative') {
    kind = 'horizontal_bar';
    cat = enc.y;
    val = enc.x;
  }
  const color = enc.color?.field && enc.color.field !== 'series' ? enc.color.field : null;
  const temporal = cat?.type === 'temporal' || cat?.type === 'quantitative';
  return {
    kind,
    x: cat?.field ?? null,
    measures: fold ?? (val?.field ? [val.field] : []),
    split: fold ? null : color,
    dataOrder: temporal || cat?.sort === null,
  };
}

/** Problems a reader would see. */
function problems(spec: Record<string, unknown>, d: Desc, table: ParsedTable, marks: number): string[] {
  const out: string[] = [];
  if (marks === 0) out.push('empty');
  const col = (f: string) => table.columns.indexOf(f);
  const maxOf = (f: string) => Math.max(...table.rows.map((r) => Math.abs(Number(r[col(f)]) || 0)));
  if (d.measures.length > 1) {
    const maxes = d.measures.filter((f) => col(f) >= 0).map(maxOf).filter((x) => x > 0);
    if (maxes.length > 1 && Math.max(...maxes) / Math.min(...maxes) > 10) out.push('mixed_scale');
  }
  if (d.kind === 'bar' && d.x && col(d.x) >= 0) {
    const labels = table.rows.map((r) => String(r[col(d.x!)] ?? ''));
    const avg = labels.reduce((n, l) => n + l.length, 0) / Math.max(labels.length, 1);
    if (labels.length > 14 || (labels.length > 6 && avg > 12)) out.push('crowded_labels');
  }
  const enc = (spec.encoding ?? {}) as Record<string, Enc | undefined>;
  const markObj = typeof spec.mark === 'object' ? (spec.mark as Record<string, unknown>) : {};
  if (spec.title || markObj.color || Object.values(enc).some((e) => e && 'value' in e && typeof e.value === 'string')) out.push('design_override');
  return out;
}

function relevant(e: Expect, d: Desc | null): { ok: boolean; why: string } {
  if (e.chart === false) return d ? { ok: false, why: 'drew a chart where none fits' } : { ok: true, why: '' };
  if (!d) return e.chart === 'either' ? { ok: true, why: '' } : { ok: false, why: 'no chart' };
  if (e.kinds && !e.kinds.includes(d.kind)) return { ok: false, why: `kind ${d.kind}` };
  if (e.x && d.x !== e.x) return { ok: false, why: `x ${d.x}` };
  if (e.measures && d.measures.some((m) => !e.measures!.includes(m))) return { ok: false, why: `measures ${d.measures.join(',')}` };
  if (d.measures.length === 0) return { ok: false, why: 'no measure' };
  if (e.single && d.measures.length !== 1) return { ok: false, why: 'mixed measures' };
  if (e.order === 'data' && !d.dataOrder) return { ok: false, why: 'reordered' };
  if (e.split && !d.split) return { ok: false, why: 'no series split' };
  return { ok: true, why: '' };
}

async function render(spec: Record<string, unknown>): Promise<{ svg: string; marks: number } | { error: string }> {
  try {
    const vg = compile({ ...spec, config: CONFIG } as never).spec;
    const view = new vega.View(vega.parse(vg), { renderer: 'none' });
    await view.runAsync();
    let marks = 0;
    const visit = (node: { marktype?: string; role?: string; items?: unknown[] }) => {
      if (node.role === 'mark' && ['rect', 'line', 'symbol', 'area'].includes(node.marktype ?? '')) marks += node.items?.length ?? 0;
      for (const it of (node.items ?? []) as (typeof node)[]) visit(it);
    };
    visit(view.scenegraph().root as never);
    const svg = await view.toSVG();
    view.finalize();
    return { svg, marks };
  } catch (e) {
    return { error: (e as Error).message.slice(0, 160) };
  }
}

interface MethodResult {
  ok: boolean;
  error: string | null;
  /** Why no spec: no_chart, a v1 check (schema, unknown_field, not_json, ...), or skipped (no numbers). */
  reason: string | null;
  attempts: number;
  output_tokens: number;
  ms: number;
  valid: boolean;
  render_error: string | null;
  marks: number;
  desc: Desc | null;
  problems: string[];
  relevant: boolean;
  relevance_note: string;
  preferred: boolean | null;
  spec: Record<string, unknown> | null;
  svg: string | null;
}

describe('visualize: model-written spec (v1) against a structured chart pick (v2)', () => {
  it.skipIf(!run)(`compares both on ${cases.length} cases with ${modelRef}`, async () => {
    const counted = countedLlm(modelRef);
    const rows: { id: string; text: string; table: ParsedTable | null; table_from: string; v1: MethodResult; v2: MethodResult }[] = [];

    for (const c of cases) {
      let table = parseTable(c.text);
      let tableFrom = table ? table.source : 'none';
      if (!table) {
        // The table step is the same for both methods: read once, shared.
        const out = await withRateLimitRetry(() =>
          counted.llm.structured({ role: 'fast', action: 'visualize_table', instructions: tablePrompt, prompt: c.text, temperature: 0, maxOutputTokens: 1500 }, VisualizeTableSchema),
        ).catch(() => null);
        table = out && out.columns.length >= 2 ? toTable(out.rows, 'model', out.columns) : null;
        tableFrom = table ? 'model' : 'none';
      }
      const types: FieldType[] = table ? inferTypes(table) : [];

      const finish = async (base: Omit<MethodResult, 'valid' | 'render_error' | 'marks' | 'desc' | 'problems' | 'relevant' | 'relevance_note' | 'preferred' | 'svg'>): Promise<MethodResult> => {
        const valid = Boolean(base.spec && isValidSpec(base.spec));
        let r: Awaited<ReturnType<typeof render>> | null = null;
        if (base.spec && valid) r = await render(base.spec);
        const drawn = r && 'svg' in r ? r : null;
        const desc = drawn && base.spec ? describeSpec(base.spec) : null;
        const rel = relevant(c.expect, desc);
        return {
          ...base,
          valid,
          render_error: r && 'error' in r ? r.error : null,
          marks: drawn?.marks ?? 0,
          desc,
          problems: drawn && desc && table ? problems(base.spec!, desc, table, drawn.marks) : [],
          relevant: rel.ok,
          relevance_note: rel.why,
          preferred: c.expect.prefer && desc ? desc.kind === c.expect.prefer : null,
          svg: drawn?.svg ?? null,
        };
      };

      const runMethod = async (method: 'v1' | 'v2'): Promise<MethodResult> => {
        const blank = { ok: true, error: null, reason: null as string | null, attempts: 0, output_tokens: 0, ms: 0, spec: null as Record<string, unknown> | null };
        if (!table) return finish({ ...blank, reason: 'no_table' });
        const measures = table.columns.filter((_, i) => types[i] === 'quantitative');
        // v2 skips the call when nothing is numeric (as the app does); v1 always asked.
        if (method === 'v2' && measures.length === 0) return finish({ ...blank, reason: 'skipped_no_numbers' });
        let t = performance.now();
        try {
          const out = await withRateLimitRetry(
            async () => {
              if (method === 'v1') return chartV1(counted.llm, table!, types);
              const choice = await counted.llm.structured(
                { role: 'fast', action: 'visualize_chart', instructions: readFileSync(join(root, 'packages', 'core', 'prompts', 'visualize-chart.md'), 'utf8'), prompt: buildChartPrompt(table!, types), temperature: 0, maxOutputTokens: 400 },
                chartChoiceSchema(table!.columns, measures),
              );
              const spec = specFromChoice(choice, table!, types);
              return { spec, reason: spec ? null : 'no_chart' };
            },
            () => {
              counted.reset();
              t = performance.now();
            },
          );
          const n = counted.calls();
          return finish({ ok: true, error: null, reason: out.reason, attempts: n.attempts, output_tokens: n.outputTokens, ms: Math.round(performance.now() - t), spec: out.spec });
        } catch (e) {
          const n = counted.calls();
          return finish({ ...blank, ok: false, error: errorLabel(e), attempts: n.attempts, output_tokens: n.outputTokens, ms: Math.round(performance.now() - t) });
        }
      };

      const v1 = await runMethod('v1');
      const v2 = await runMethod('v2');
      rows.push({ id: c.id, text: c.text, table, table_from: tableFrom, v1, v2 });
      console.log(`${c.id.padEnd(7)} v1 ${v1.relevant ? 'ok ' : 'BAD'} ${(v1.desc?.kind ?? v1.reason ?? v1.error ?? '').padEnd(16)} ${v1.problems.join(',').padEnd(20)} | v2 ${v2.relevant ? 'ok ' : 'BAD'} ${v2.desc?.kind ?? v2.reason ?? v2.error ?? ''} ${v2.problems.join(',')}`);
    }

    const summarize = (pick: (r: (typeof rows)[number]) => MethodResult) => {
      const rs = rows.map(pick);
      const called = rs.filter((r) => r.attempts > 0 || !r.ok);
      const drawn = rs.filter((r) => r.svg);
      const prefer = rs.filter((r) => r.preferred !== null);
      return {
        calls: called.length,
        call_failures: rs.filter((r) => !r.ok).length,
        retried: rs.filter((r) => r.attempts > 1).length,
        specs_rejected: rs.filter((r) => r.ok && r.reason && !['no_chart', 'no_table', 'skipped_no_numbers'].includes(r.reason)).length,
        rejected_reasons: rs.filter((r) => r.reason && !['no_chart', 'no_table', 'skipped_no_numbers'].includes(r.reason)).map((r) => r.reason),
        render_errors: rs.filter((r) => r.render_error).length,
        charts_drawn: drawn.length,
        charts_with_problems: drawn.filter((r) => r.problems.length > 0).length,
        problems: drawn.flatMap((r) => r.problems),
        relevant: rs.filter((r) => r.relevant).length,
        relevance_rate: rs.filter((r) => r.relevant).length / rs.length,
        preferred_kind: `${prefer.filter((r) => r.preferred).length}/${prefer.length}`,
        median_ms: median(called.map((r) => r.ms)),
        median_output_tokens: median(called.map((r) => r.output_tokens)),
      };
    };
    const summary = { eval: 'visualize-compare', model: modelRef, at: new Date().toISOString(), cases: rows.length, v1: summarize((r) => r.v1), v2: summarize((r) => r.v2) };
    console.log(JSON.stringify({ v1: summary.v1, v2: summary.v2 }, null, 2));

    mkdirSync(resultsDir, { recursive: true });
    const strip = (m: MethodResult) => ({ ...m, svg: undefined });
    writeFileSync(join(resultsDir, 'visualize-compare.json'), JSON.stringify({ ...summary, results: rows.map((r) => ({ ...r, table: r.table && { columns: r.table.columns, rows: r.table.rows.length }, v1: strip(r.v1), v2: strip(r.v2) })) }, null, 2));
    writeFileSync(join(resultsDir, 'visualize-compare.html'), htmlReport(summary, rows));
    expect(rows).toHaveLength(cases.length);
  }, 3_600_000);
});

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function cell(m: MethodResult): string {
  const status = m.relevant ? '<span class="ok">relevant</span>' : `<span class="bad">not relevant${m.relevance_note ? `: ${esc(m.relevance_note)}` : ''}</span>`;
  const meta = [m.desc?.kind ?? m.reason ?? m.error ?? '', m.ms ? `${m.ms} ms` : '', m.output_tokens ? `${m.output_tokens} tok` : '', m.attempts > 1 ? `${m.attempts} tries` : '']
    .filter(Boolean)
    .join(' · ');
  const probs = m.problems.length ? `<div class="bad">${m.problems.join(', ')}</div>` : '';
  const body = m.svg ? m.svg : `<div class="none">${esc(m.render_error ?? m.error ?? m.reason ?? 'no chart')}</div>`;
  return `<td><div class="meta">${status} · ${esc(meta)}</div>${probs}${body}</td>`;
}

function htmlReport(summary: { model: string; at: string; v1: object; v2: object }, rows: { id: string; text: string; table_from: string; v1: MethodResult; v2: MethodResult }[]): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Visualize compare</title><style>
body{font:14px "Segoe UI",sans-serif;margin:24px;color:#0d0d0d;background:#fafafa}
table{border-collapse:collapse;width:100%}td,th{vertical-align:top;border-top:1px solid #ddd;padding:12px;background:#fff}
th{text-align:left;background:#f0f0f0}pre{white-space:pre-wrap;font-size:11px;max-width:260px;max-height:180px;overflow:auto;margin:0}
.meta{font-size:12px;color:#555;margin-bottom:6px}.ok{color:#0a7a3e;font-weight:600}.bad{color:#b3261e;font-weight:600}.none{color:#888;padding:40px 0}
.sum{display:flex;gap:24px}.sum pre{max-width:none;max-height:none;font-size:12px;background:#fff;padding:12px;border:1px solid #ddd}
</style></head><body><h1>Visualize: model-written spec (v1) vs structured pick (v2)</h1>
<p>${esc(summary.model)} · ${esc(summary.at)}</p><div class="sum"><pre>v1 ${esc(JSON.stringify(summary.v1, null, 2))}</pre><pre>v2 ${esc(JSON.stringify(summary.v2, null, 2))}</pre></div>
<table><tr><th>Case</th><th>v1: model writes the Vega-Lite spec</th><th>v2: model picks, code writes</th></tr>
${rows.map((r) => `<tr><td><b>${r.id}</b> <span class="meta">table: ${r.table_from}</span><pre>${esc(r.text.slice(0, 600))}</pre></td>${cell(r.v1)}${cell(r.v2)}</tr>`).join('\n')}
</table></body></html>`;
}
