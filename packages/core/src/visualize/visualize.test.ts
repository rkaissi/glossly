import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import type { ChatRequest, LlmProvider } from '../llm/types';
import { LlmError } from '../llm/types';
import { inferTypes, parseNumber, parseTable, safeColumns, splitDelimited, toCsv } from './table';
import { isValidSpec, rulesSpec, specFromChoice, visualize, type ChartChoice } from './visualize';

const TSV = 'Region\tQ1\tQ2\nNorth\t120\t140\nSouth\t90\t95\nWest\t70\t88';

describe('parseTable', () => {
  it('reads TSV, CSV with quotes, Markdown, and aligned columns', () => {
    expect(parseTable(TSV)).toMatchObject({ source: 'tsv', columns: ['Region', 'Q1', 'Q2'], rows: [['North', 120, 140], ['South', 90, 95], ['West', 70, 88]] });
    const csv = parseTable('Name,Revenue\n"Acme, Inc.","$1,200"\nGlobex,$900\nInitech,"$4.2M"');
    expect(csv?.source).toBe('csv');
    expect(csv?.rows).toEqual([['Acme, Inc.', 1200], ['Globex', 900], ['Initech', 4_200_000]]);
    const md = parseTable('| Month | Users |\n|---|---:|\n| Jan | 10 |\n| Feb | 12 |\n| Mar | 15 |');
    expect(md).toMatchObject({ source: 'markdown', columns: ['Month', 'Users'], rows: [['Jan', 10], ['Feb', 12], ['Mar', 15]] });
    const aligned = parseTable('Team      Wins   Losses\nRed       10     2\nBlue      7      5');
    expect(aligned).toMatchObject({ source: 'aligned', rows: [['Red', 10, 2], ['Blue', 7, 5]] });
  });

  it('names columns when the first row is data, and refuses prose', () => {
    expect(parseTable('1\t2\n3\t4\n5\t6')?.columns).toEqual(['Column 1', 'Column 2']);
    expect(parseTable('We met on Friday.\nThe launch is next week.\nThanks, Maya')).toBeNull();
    expect(parseTable('a,b\n1,2')).toBeNull();
  });

  it('parses numbers with units, and keeps field names safe for Vega-Lite', () => {
    expect([parseNumber('40%'), parseNumber('(12)'), parseNumber('−3.5'), parseNumber('12.1k'), parseNumber('v2')]).toEqual([40, -12, -3.5, 12100, null]);
    expect(safeColumns(['a.b', '', 'x', 'x'])).toEqual(['a b', 'Column 2', 'x', 'x 2']);
    expect(splitDelimited('"say ""hi""",2', ',')).toEqual(['say "hi"', '2']);
  });

  it('infers types and writes CSV', () => {
    const t = parseTable('Year,Sales\n2021,10\n2022,12\n2023,15')!;
    expect(inferTypes(t)).toEqual(['ordinal', 'quantitative']);
    expect(inferTypes(parseTable('Date,Users\n2026-10-01,5\n2026-10-02,7\n2026-10-03,9')!)).toEqual(['temporal', 'quantitative']);
    expect(toCsv(parseTable('Name,Note\nA,"x, y"\nB,z')!)).toBe('Name,Note\nA,"x, y"\nB,z');
  });
});

describe('specFromChoice', () => {
  const table = parseTable(TSV)!;
  const types = inferTypes(table);
  const pick = (over: Partial<ChartChoice>): ChartChoice => ({ chart: 'bar', x: 'Region', measures: ['Q1'], split_by: '', sort: 'data', ...over });

  it('writes a spec that passes the Vega-Lite schema, with the rows inlined', () => {
    const spec = specFromChoice(pick({}), table, types)!;
    expect(isValidSpec(spec)).toBe(true);
    expect((spec.data as { values: unknown[] }).values).toHaveLength(3);
    expect(spec.encoding).toMatchObject({ x: { field: 'Region', type: 'nominal' }, y: { field: 'Q1', type: 'quantitative' } });
  });

  it('folds several measures, sorts and turns bars, and draws a line with points', () => {
    const grouped = specFromChoice(pick({ measures: ['Q1', 'Q2'] }), table, types)!;
    expect(grouped.transform).toEqual([{ fold: ['Q1', 'Q2'], as: ['series', 'value'] }]);
    expect(grouped.encoding).toMatchObject({ color: { field: 'series' }, xOffset: { field: 'series' } });
    expect(isValidSpec(grouped)).toBe(true);
    const ranked = specFromChoice(pick({ chart: 'horizontal_bar', sort: 'descending' }), table, types)!;
    expect(ranked.encoding).toMatchObject({ y: { field: 'Region', sort: '-x' }, x: { field: 'Q1' } });
    expect(isValidSpec(ranked)).toBe(true);
    const line = specFromChoice(pick({ chart: 'line', sort: 'descending' }), table, types)!;
    expect(line.mark).toEqual({ type: 'line', tooltip: true, point: true });
    expect((line.encoding as { x: { sort: unknown } }).x.sort).toBeNull();
  });

  it('drops what it cannot plot: none, a category as a measure, a scatter over categories', () => {
    expect(specFromChoice(pick({ chart: 'none' }), table, types)).toBeNull();
    expect(specFromChoice(pick({ measures: ['Region'] }), table, types)).toBeNull();
    expect((specFromChoice(pick({ chart: 'point' }), table, types)!.mark as { type: string }).type).toBe('bar');
  });
});

describe('rulesSpec', () => {
  it('folds several measures into grouped bars, and draws a line over dates', () => {
    const t = parseTable(TSV)!;
    const bars = rulesSpec(t, inferTypes(t))!;
    expect(bars.mark).toMatchObject({ type: 'bar' });
    expect(bars.transform).toEqual([{ fold: ['Q1', 'Q2'], as: ['series', 'value'] }]);
    const d = parseTable('Date,Users\n2026-10-01,5\n2026-10-02,7\n2026-10-03,9')!;
    expect(rulesSpec(d, inferTypes(d))!.mark).toMatchObject({ type: 'line' });
    const words = parseTable('Name,Team\nA,Red\nB,Blue\nC,Red')!;
    expect(rulesSpec(words, inferTypes(words))).toBeNull();
  });
});

class FakeLlm implements LlmProvider {
  calls: ChatRequest[] = [];
  constructor(private readonly answer: (req: ChatRequest) => unknown) {}
  stream(): never {
    throw new Error('not used');
  }
  async structured<T>(req: ChatRequest, schema: z.ZodType<T>): Promise<T> {
    this.calls.push(req);
    return schema.parse(this.answer(req));
  }
  hasModel(): boolean {
    return true;
  }
}

describe('visualize', () => {
  const settings = (localOnly = false) => () => ({ localOnly });

  it("draws the model's pick, without a table call for a parsed table", async () => {
    const llm = new FakeLlm(() => ({ chart: 'bar', x: 'Region', measures: ['Q2'], split_by: '', sort: 'descending' }));
    const r = await visualize({ llm, settings: settings() }, TSV);
    expect(r).toMatchObject({ ok: true, chartBy: 'model', note: null, spec: { encoding: { y: { field: 'Q2' } } } });
    expect(llm.calls.map((c) => c.action)).toEqual(['visualize_chart']);
  });

  it('shows the table when the pick names a column that is not there, and asks for rows when the shape is unclear', async () => {
    // The schema's enums refuse the unknown column; the model layer would retry, then fail.
    const bad = new FakeLlm(() => ({ chart: 'bar', x: 'Nope', measures: ['Q1'], split_by: '', sort: 'data' }));
    const r1 = await visualize({ llm: bad, settings: settings() }, TSV);
    expect(r1).toMatchObject({ ok: true, spec: null, chartBy: null });
    expect(r1.ok && r1.note).toMatch(/so here is the table/);

    const prose = new FakeLlm((req) =>
      req.action === 'visualize_table'
        ? { columns: ['Quarter', 'Revenue'], rows: [['Q1', '$1.2M'], ['Q2', '$1.5M']] }
        : { chart: 'none', x: 'Quarter', measures: ['Revenue'], split_by: '', sort: 'data' },
    );
    const r2 = await visualize({ llm: prose, settings: settings() }, 'Revenue was $1.2M in Q1 and $1.5M in Q2.');
    expect(r2).toMatchObject({ ok: true, table: { source: 'model', rows: [['Q1', 1_200_000], ['Q2', 1_500_000]] }, spec: null });
  });

  it('with Local only, charts a parsed table by rules and makes no model call', async () => {
    const llm = new FakeLlm(() => {
      throw new LlmError('local_only', 'Local only is on');
    });
    expect(await visualize({ llm, settings: settings(true) }, TSV)).toMatchObject({ ok: true, chartBy: 'rules' });
    expect(await visualize({ llm, settings: settings(true) }, 'Revenue was up a lot.')).toMatchObject({ ok: false, code: 'local_only' });
    expect(llm.calls).toEqual([]);
  });
});
