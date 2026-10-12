// Chart scoring shared by the Visualize evals: what a Vega-Lite spec draws, the problems a reader
// would see, whether it fits what the case expects, and rendering it as the app would.
import * as vega from 'vega';
import { compile } from 'vega-lite';
import type { ParsedTable } from '@glossly/core';

export interface Expect {
  chart: boolean | 'either';
  kinds?: string[];
  prefer?: string;
  x?: string | null;
  measures?: string[];
  single?: boolean;
  order?: 'data';
  split?: boolean;
}

/** The app's light-mode chart config (VisualizePanel's chartConfig with the light tokens), so both methods render as the app would. */
export const CONFIG = {
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

export interface Desc {
  kind: string;
  x: string | null;
  measures: string[];
  split: string | null;
  /** The category axis keeps the rows' order (sort: null). */
  dataOrder: boolean;
}

type Enc = { field?: string; type?: string; sort?: unknown; value?: unknown; axis?: { labelAngle?: number } | null };

/** What a spec draws, read the same way for both methods. */
export function describeSpec(spec: Record<string, unknown>): Desc {
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
export function problems(spec: Record<string, unknown>, d: Desc, table: ParsedTable, marks: number): string[] {
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

export function relevant(e: Expect, d: Desc | null): { ok: boolean; why: string } {
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

export async function render(spec: Record<string, unknown>): Promise<{ svg: string; marks: number } | { error: string }> {
  try {
    const vg = compile({ ...spec, config: CONFIG } as never).spec;
    const view = new vega.View(vega.parse(vg), { renderer: 'none' });
    await view.runAsync();
    let marks = 0;
    const visit = (node: { marktype?: string; role?: string; items?: unknown[] }) => {
      if (node.role === 'mark' && ['rect', 'line', 'symbol', 'area'].includes(node.marktype ?? '')) marks += node.items?.length ?? 0;
      for (const it of (node.items ?? []) as (typeof node)[]) visit(it);
    };
    visit((view.scenegraph() as unknown as { root: never }).root);
    const svg = await view.toSVG();
    view.finalize();
    return { svg, marks };
  } catch (e) {
    return { error: (e as Error).message.slice(0, 160) };
  }
}
