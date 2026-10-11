// Visualize's chart step as it was before Step 16.13 (commit 567937f): the model writes a whole
// Vega-Lite spec as a JSON string, and code checks it. Kept only so evals/visualize-compare.eval.ts
// can compare it with the structured chart pick. Not used by the app.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { buildChartPrompt, isValidSpec, type FieldType, type LlmProvider, type ParsedTable } from '@glossly/core';

const prompt = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'visualize-chart-v1.md'), 'utf8');
const CHART_SIZE = { width: 440, height: 220 };
const FORBIDDEN_KEYS = new Set(['url', 'href', 'usermeta', 'datasets']);

export const VisualizeChartSchemaV1 = z.object({ spec_json: z.string() });

const rowObjects = (t: ParsedTable) => t.rows.map((r) => Object.fromEntries(t.columns.map((c, i) => [c, r[i] ?? null])));

function walk(v: unknown, visit: (key: string, value: unknown) => void): void {
  if (Array.isArray(v)) v.forEach((x) => walk(x, visit));
  else if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) {
      visit(k, x);
      walk(x, visit);
    }
  }
}

/** The old prepareSpec, unchanged except that the schema check uses core's validator (the same Ajv setup). */
export function prepareSpecV1(json: string, table: ParsedTable): { ok: true; spec: Record<string, unknown> } | { ok: false; reason: string } {
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
  const enc = spec.encoding as Record<string, unknown> | undefined;
  if (enc && typeof enc === 'object' && enc.tooltip === true) {
    const { tooltip: _drop, ...rest } = enc;
    spec.encoding = rest;
  }
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
  if (!isValidSpec(full)) return { ok: false, reason: 'schema' };
  return { ok: true, spec: full };
}

/** One call, as before: the spec as a JSON string, checked by prepareSpecV1. Empty means "no chart fits". */
export async function chartV1(llm: LlmProvider, table: ParsedTable, types: FieldType[]): Promise<{ spec: Record<string, unknown> | null; reason: string | null }> {
  const out = await llm.structured(
    { role: 'fast', action: 'visualize_chart', instructions: prompt, prompt: buildChartPrompt(table, types), temperature: 0, maxOutputTokens: 1200 },
    VisualizeChartSchemaV1,
  );
  if (!out.spec_json.trim()) return { spec: null, reason: 'no_chart' };
  const prepared = prepareSpecV1(out.spec_json, table);
  return prepared.ok ? { spec: prepared.spec, reason: null } : { spec: null, reason: prepared.reason };
}
