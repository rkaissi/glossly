// Visualize (spec: Actions, Visualize): parse the table in code when its shape allows, else ask
// the model for rows; then the model picks a chart (the kind and the columns, as enums of the
// table's own columns), code writes the Vega-Lite spec, and the spec is checked against the
// Vega-Lite JSON schema before it is shown; when anything fails, the table is shown.
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

export const VisualizeTableSchema = z.object({
  columns: z.array(z.string()).describe('Short column names.'),
  rows: z.array(z.array(z.string())).describe('One array per row, one string per column, in column order.'),
});

/** The charts the model can pick. Code writes the Vega-Lite spec for each. */
export const CHART_KINDS = ['bar', 'horizontal_bar', 'line', 'area', 'point', 'none'] as const;
export type ChartKind = (typeof CHART_KINDS)[number];
export const CHART_SORTS = ['data', 'ascending', 'descending'] as const;

export interface ChartChoice {
  chart: ChartKind;
  /** The category or time axis (for `point`, the first measure). */
  x: string;
  /** Numeric columns to plot; more than one become series. */
  measures: string[];
  /** A category column whose values become separate series, or "" for none. */
  split_by: string;
  sort: (typeof CHART_SORTS)[number];
}

const nonEmpty = (xs: string[]) => xs as [string, ...string[]];

/**
 * The model's chart pick for one table: the kind and the columns, each an enum of this table's
 * own column names, so it can't name a field that isn't there. `measures` lists the numeric columns.
 */
export function chartChoiceSchema(columns: string[], measures: string[]) {
  return z.object({
    chart: z.enum(CHART_KINDS),
    x: z.enum(nonEmpty(columns)).describe('The category or time column for the axis. For point, the first numeric column.'),
    measures: z.array(z.enum(nonEmpty(measures))).describe('The numeric columns to plot, at least one.'),
    split_by: z.enum(nonEmpty(['', ...columns])).describe('A category column whose values become separate series, or "" for none.'),
    sort: z.enum(CHART_SORTS).describe('Bar order; data keeps the table order.'),
  });
}

let validator: ValidateFunction | null = null;

/** The Vega-Lite schema validator, compiled once on first use (about 0.4 s). */
function vegaLiteValidator(): ValidateFunction {
  // inlineRefs off and no code optimization: the schema is 1.9 MB, and this keeps the compile short.
  validator ??= new Ajv({ strict: false, validateFormats: false, logger: false, inlineRefs: false, code: { optimize: false } }).compile(vegaLiteSchema);
  return validator;
}

/** A last check on a spec code wrote: it has to pass the Vega-Lite JSON schema. */
export const isValidSpec = (spec: Record<string, unknown>) => Boolean(vegaLiteValidator()(spec));

const rowObjects = (t: ParsedTable) => t.rows.map((r) => Object.fromEntries(t.columns.map((c, i) => [c, r[i] ?? null])));

/**
 * The Vega-Lite spec for a chart pick, written in code with the rows inlined. Fields that
 * aren't numeric are dropped from the measures; a point chart needs a numeric x (else bars);
 * several measures fold into "series" and "value" with a color per series (grouped bars, one
 * line each). Null for "none" or nothing to plot.
 */
export function specFromChoice(c: ChartChoice, table: ParsedTable, types: FieldType[]): Record<string, unknown> | null {
  const typeOf = (f: string): FieldType => types[table.columns.indexOf(f)] ?? 'nominal';
  if (c.chart === 'none' || !table.columns.includes(c.x)) return null;
  let measures = [...new Set(c.measures)].filter((m) => m !== c.x && table.columns.includes(m) && typeOf(m) === 'quantitative');
  if (measures.length === 0) return null;
  let kind = c.chart;
  if (kind === 'point' && typeOf(c.x) !== 'quantitative') kind = 'bar';
  if (kind === 'point') measures = measures.slice(0, 1);
  const several = measures.length > 1;
  const split =
    !several && c.split_by && c.split_by !== c.x && !measures.includes(c.split_by) && table.columns.includes(c.split_by) && typeOf(c.split_by) !== 'quantitative'
      ? c.split_by
      : null;
  const series = several ? 'series' : split;
  const horizontal = kind === 'horizontal_bar';
  const mark = horizontal ? 'bar' : kind;

  let encoding: Record<string, unknown>;
  if (kind === 'point') {
    encoding = { x: { field: c.x, type: 'quantitative' }, y: { field: measures[0], type: 'quantitative' } };
  } else {
    const valueAxis = horizontal ? 'x' : 'y';
    const sort = mark !== 'bar' || c.sort === 'data' ? null : c.sort === 'ascending' ? valueAxis : '-' + valueAxis;
    const cat = { field: c.x, type: typeOf(c.x), sort, ...(mark === 'bar' && !horizontal && { axis: { labelAngle: 0 } }) };
    const value = { field: several ? 'value' : measures[0], type: 'quantitative', ...(several && { title: null }) };
    encoding = horizontal ? { y: cat, x: value } : { x: cat, y: value };
  }
  if (series) {
    encoding.color = { field: series, type: 'nominal', ...(several && { sort: measures }) };
    if (mark === 'bar') encoding[horizontal ? 'yOffset' : 'xOffset'] = { field: series, ...(several && { sort: measures }) };
  }
  return {
    ...(several && { transform: [{ fold: measures, as: ['series', 'value'] }] }),
    mark: { type: mark, tooltip: true, ...(mark === 'line' && { point: true }) },
    encoding,
    data: { values: rowObjects(table) },
    ...CHART_SIZE,
    autosize: { type: 'fit', contains: 'padding' },
  };
}

/**
 * Code's own pick when there is no model (Local only, no key): a line over dates or many
 * ordered values, else bars per category; with only numbers, a scatter of the first two.
 * Null when nothing is numeric.
 */
export function rulesChoice(table: ParsedTable, types: FieldType[]): ChartChoice | null {
  const xi = types.findIndex((t) => t !== 'quantitative');
  const measures = table.columns.filter((_, i) => types[i] === 'quantitative' && i !== xi);
  if (measures.length === 0) return null;
  if (xi < 0) return measures.length < 2 ? null : { chart: 'point', x: measures[0]!, measures: [measures[1]!], split_by: '', sort: 'data' };
  const xType = types[xi]!;
  const line = xType === 'temporal' || (xType === 'ordinal' && table.rows.length > 6);
  return { chart: line ? 'line' : 'bar', x: table.columns[xi]!, measures, split_by: '', sort: 'data' };
}

export function rulesSpec(table: ParsedTable, types: FieldType[]): Record<string, unknown> | null {
  const choice = rulesChoice(table, types);
  return choice ? specFromChoice(choice, table, types) : null;
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
  let rejected: string | undefined;
  const measures = table.columns.filter((_, i) => types[i] === 'quantitative');
  if (measures.length === 0) return { ok: true, table, types, spec: null, chartBy: null, note: 'No numbers to chart, so here is the table.', csv };
  try {
    const choice = await deps.llm.structured(
      { role: 'fast', action: 'visualize_chart', instructions: chartPrompt, prompt: buildChartPrompt(table, types), signal, temperature: 0, maxOutputTokens: 400 },
      chartChoiceSchema(table.columns, measures),
    );
    const spec = specFromChoice(choice, table, types);
    if (spec && isValidSpec(spec)) return { ok: true, table, types, spec, chartBy: 'model', note: null, csv };
    if (spec) {
      note = "The model's chart didn't check out";
      rejected = 'schema';
    } else note = 'The model found no chart that fits';
  } catch (e) {
    if (signal?.aborted) return failure(e, signal);
    note = "The model didn't answer";
  }
  // Spec: when the chart fails, show the parsed table.
  return { ok: true, table, types, spec: null, chartBy: null, note: `${note}, so here is the table.`, csv, ...(rejected && { rejected }) };
}
