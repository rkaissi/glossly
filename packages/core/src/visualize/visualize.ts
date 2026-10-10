// Visualize (spec: Actions, Visualize): parse the table in code when its shape allows, else ask
// the model for rows; then the model picks a chart as a Vega-Lite spec, which is validated
// against the Vega-Lite JSON schema before it is shown; when it fails, the table is shown.
// Local only, or no key: the table must parse in code, and code picks a plain chart.
import Ajv, { type ValidateFunction } from 'ajv';
import vegaLiteSchema from 'vega-lite/vega-lite-schema.json';
import { z } from 'zod';
import chartPrompt from '../../prompts/visualize-chart.md?raw';
import tablePrompt from '../../prompts/visualize-table.md?raw';
import { LlmError, type LlmProvider } from '../llm/types';
import type { Settings } from '../settings';
import { inferTypes, parseTable, toCsv, toTable } from './table';
import type { Cell, FieldType, ParsedTable, VisualizeResult } from './types';

const MAX_PROMPT_CHARS = 6000;
const SAMPLE_ROWS = 8;
const CHART_SIZE = { width: 440, height: 220 };

export const VisualizeTableSchema = z.object({ columns: z.array(z.string()), rows: z.array(z.array(z.string())) });
export const VisualizeChartSchema = z.object({ spec_json: z.string() });

let validator: ValidateFunction | null = null;

/** The Vega-Lite schema validator, compiled once on first use (about 0.4 s). */
function vegaLiteValidator(): ValidateFunction {
  // inlineRefs off and no code optimization: the schema is 1.9 MB, and this keeps the compile short.
  validator ??= new Ajv({ strict: false, validateFormats: false, logger: false, inlineRefs: false, code: { optimize: false } }).compile(vegaLiteSchema);
  return validator;
}

const rowObjects = (t: ParsedTable) => t.rows.map((r) => Object.fromEntries(t.columns.map((c, i) => [c, r[i] ?? null])));

/** Keys that could load or link anything outside the app. Not allowed anywhere in a spec. */
const FORBIDDEN_KEYS = new Set(['url', 'href', 'usermeta', 'datasets']);

function walk(v: unknown, visit: (key: string, value: unknown) => void): void {
  if (Array.isArray(v)) v.forEach((x) => walk(x, visit));
  else if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) {
      visit(k, x);
      walk(x, visit);
    }
  }
}

/**
 * Checks a model-written spec and fills in the rows. Valid when it parses, uses no forbidden
 * keys or image marks, references only the table's columns (or names its own transforms
 * create), and passes the Vega-Lite JSON schema.
 */
export function prepareSpec(json: string, table: ParsedTable): { ok: true; spec: Record<string, unknown> } | { ok: false; reason: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return { ok: false, reason: 'not_json' };
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, reason: 'not_object' };
  const spec = { ...(raw as Record<string, unknown>) };
  delete spec.config;
  delete spec.data;

  let reason: string | null = null;
  const fields = new Set<string>();
  const created = new Set<string>();
  walk(spec, (key, value) => {
    if (FORBIDDEN_KEYS.has(key)) reason ??= 'forbidden_key';
    if (key === 'mark' && (value === 'image' || (value as { type?: unknown })?.type === 'image')) reason ??= 'image_mark';
    if (key === 'field' && typeof value === 'string') fields.add(value);
    if (key === 'fold' && Array.isArray(value)) value.forEach((f) => typeof f === 'string' && fields.add(f));
    if (key === 'as') (Array.isArray(value) ? value : [value]).forEach((a) => typeof a === 'string' && created.add(a));
  });
  if (reason) return { ok: false, reason };
  const known = new Set([...table.columns, ...created]);
  if ([...fields].some((f) => !known.has(f))) return { ok: false, reason: 'unknown_field' };

  const full = { ...spec, data: { values: rowObjects(table) }, ...CHART_SIZE, autosize: { type: 'fit', contains: 'padding' } };
  if (!vegaLiteValidator()(full)) return { ok: false, reason: 'schema' };
  return { ok: true, spec: full };
}

/**
 * Code picks the chart when there is no model (Local only, no key): a line over dates, else
 * bars per category; several numeric columns fold into series. Null when nothing is numeric.
 */
export function rulesSpec(table: ParsedTable, types: FieldType[]): Record<string, unknown> | null {
  const xi = types.findIndex((t) => t !== 'quantitative');
  const measures = table.columns.filter((_, i) => types[i] === 'quantitative' && i !== xi);
  if (measures.length === 0) return null;
  if (xi < 0) {
    // Only numbers: the first two columns as a scatter.
    if (measures.length < 2) return null;
    return {
      mark: { type: 'point', tooltip: true },
      encoding: { x: { field: measures[0], type: 'quantitative' }, y: { field: measures[1], type: 'quantitative' } },
      data: { values: rowObjects(table) },
      ...CHART_SIZE,
    };
  }
  const x = table.columns[xi]!;
  const xType = types[xi]!;
  const line = xType === 'temporal' || (xType === 'ordinal' && table.rows.length > 6);
  const several = measures.length > 1;
  const encoding: Record<string, unknown> = {
    x: { field: x, type: xType, sort: null, ...(line ? {} : { axis: { labelAngle: 0 } }) },
    y: { field: several ? 'value' : measures[0], type: 'quantitative', ...(several ? { title: null } : {}) },
  };
  if (several) {
    encoding.color = { field: 'series', type: 'nominal', sort: measures };
    if (!line) encoding.xOffset = { field: 'series', sort: measures };
  }
  return {
    ...(several && { transform: [{ fold: measures, as: ['series', 'value'] }] }),
    mark: { type: line ? 'line' : 'bar', tooltip: true, ...(line && { point: true }) },
    encoding,
    data: { values: rowObjects(table) },
    ...CHART_SIZE,
  };
}

export function buildChartPrompt(table: ParsedTable, types: FieldType[]): string {
  const sample = table.rows.slice(0, SAMPLE_ROWS).map((r) => r.map((c: Cell) => (c === null ? '' : String(c))).join(' | '));
  return [
    `## Fields (${table.rows.length} rows)`,
    ...table.columns.map((c, i) => `- "${c}": ${types[i]}`),
    '',
    '## First rows',
    table.columns.join(' | '),
    ...sample,
  ].join('\n');
}

export interface VisualizeDeps {
  llm: LlmProvider;
  settings: () => Pick<Settings, 'localOnly'>;
}

function failure(e: unknown, signal?: AbortSignal): Extract<VisualizeResult, { ok: false }> {
  const code = e instanceof LlmError ? e.code : signal?.aborted ? 'aborted' : 'provider';
  return { ok: false, code, message: e instanceof LlmError ? e.message : 'The model call failed.' };
}

/** Runs Visualize on the selected text. Never throws for a model failure; it falls back or reports it. */
export async function visualize(deps: VisualizeDeps, text: string, signal?: AbortSignal): Promise<VisualizeResult> {
  if (!text.trim()) return { ok: false, code: 'no_selection', message: 'Nothing is selected.' };
  const useModel = !deps.settings().localOnly && deps.llm.hasModel('fast');

  let table = parseTable(text);
  if (!table) {
    if (!useModel) {
      return deps.settings().localOnly
        ? { ok: false, code: 'local_only', message: "Local only is on, and this text isn't shaped like a table, so it can't be read without a model." }
        : { ok: false, code: 'no_table', message: "This text isn't shaped like a table. Add a key so a model can read it." };
    }
    try {
      const out = await deps.llm.structured(
        { role: 'fast', action: 'visualize_table', instructions: tablePrompt, prompt: text.slice(0, MAX_PROMPT_CHARS), signal, temperature: 0, maxOutputTokens: 1500 },
        VisualizeTableSchema,
      );
      table = out.columns.length >= 2 ? toTable(out.rows, 'model', out.columns) : null;
    } catch (e) {
      return failure(e, signal);
    }
    if (!table) return { ok: false, code: 'no_table', message: 'No table or figures found in this selection.' };
  }

  const types = inferTypes(table);
  const csv = toCsv(table);
  const byRules = rulesSpec(table, types);
  if (!useModel) {
    return { ok: true, table, types, spec: byRules, chartBy: byRules ? 'rules' : null, note: byRules ? null : 'No numbers to chart, so here is the table.', csv };
  }

  let note: string | null = null;
  try {
    const out = await deps.llm.structured(
      { role: 'fast', action: 'visualize_chart', instructions: chartPrompt, prompt: buildChartPrompt(table, types), signal, temperature: 0, maxOutputTokens: 1200 },
      VisualizeChartSchema,
    );
    if (out.spec_json.trim()) {
      const prepared = prepareSpec(out.spec_json, table);
      if (prepared.ok) return { ok: true, table, types, spec: prepared.spec, chartBy: 'model', note: null, csv };
      note = "The model's chart didn't check out";
    } else note = 'The model found no chart that fits';
  } catch (e) {
    if (signal?.aborted) return failure(e, signal);
    note = "The model didn't answer";
  }
  // Spec: when the chart fails, show the parsed table.
  return { ok: true, table, types, spec: null, chartBy: null, note: `${note}, so here is the table.`, csv };
}
