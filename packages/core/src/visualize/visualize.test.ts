import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import type { ChatRequest, LlmProvider } from '../llm/types';
import { LlmError } from '../llm/types';
import { inferTypes, parseNumber, parseTable, safeColumns, splitDelimited, toCsv } from './table';
import { prepareSpec, rulesSpec, visualize } from './visualize';

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

describe('prepareSpec', () => {
  const table = parseTable(TSV)!;
  const good = JSON.stringify({ data: { name: 'table' }, mark: { type: 'bar', tooltip: true }, encoding: { x: { field: 'Region', type: 'nominal' }, y: { field: 'Q1', type: 'quantitative' } } });

  it('inlines the rows and passes the Vega-Lite schema', () => {
    const r = prepareSpec(good, table);
    expect(r.ok).toBe(true);
    if (r.ok) expect((r.spec.data as { values: unknown[] }).values).toHaveLength(3);
  });

  it('rejects remote data, unknown fields, image marks, and specs the schema refuses', () => {
    const withUrl = JSON.stringify({ data: { url: 'https://example.com/x.csv' }, mark: 'bar', encoding: { href: { field: 'Region' } } });
    expect(prepareSpec(withUrl, table)).toEqual({ ok: false, reason: 'forbidden_key' });
    expect(prepareSpec(good.replace('"Q1"', '"Q9"'), table)).toEqual({ ok: false, reason: 'unknown_field' });
    expect(prepareSpec(JSON.stringify({ mark: 'image', encoding: {} }), table)).toEqual({ ok: false, reason: 'image_mark' });
    expect(prepareSpec(JSON.stringify({ mark: 'sparkle', encoding: {} }), table)).toEqual({ ok: false, reason: 'schema' });
    expect(prepareSpec('not json', table)).toEqual({ ok: false, reason: 'not_json' });
  });

  it('drops a tooltip: true under encoding instead of refusing the whole spec', () => {
    const slip = JSON.stringify({ data: { name: 'table' }, mark: { type: 'bar', tooltip: true }, encoding: { x: { field: 'Region', type: 'nominal' }, y: { field: 'Q1', type: 'quantitative' }, tooltip: true } });
    expect(prepareSpec(slip, table).ok).toBe(true);
  });

  it('accepts fields a fold transform creates', () => {
    const folded = JSON.stringify({
      data: { name: 'table' },
      transform: [{ fold: ['Q1', 'Q2'], as: ['series', 'value'] }],
      mark: 'line',
      encoding: { x: { field: 'Region', type: 'nominal' }, y: { field: 'value', type: 'quantitative' }, color: { field: 'series', type: 'nominal' } },
    });
    expect(prepareSpec(folded, table).ok).toBe(true);
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

  it('uses the model spec when it validates, without a table call for a parsed table', async () => {
    const llm = new FakeLlm(() => ({ spec_json: JSON.stringify({ data: { name: 'table' }, mark: 'bar', encoding: { x: { field: 'Region', type: 'nominal' }, y: { field: 'Q2', type: 'quantitative' } } }) }));
    const r = await visualize({ llm, settings: settings() }, TSV);
    expect(r).toMatchObject({ ok: true, chartBy: 'model', note: null });
    expect(llm.calls.map((c) => c.action)).toEqual(['visualize_chart']);
  });

  it('shows the table when the model spec fails, and asks the model for rows when the shape is unclear', async () => {
    const bad = new FakeLlm(() => ({ spec_json: '{"mark":"bar","encoding":{"x":{"field":"Nope","type":"nominal"}}}' }));
    const r1 = await visualize({ llm: bad, settings: settings() }, TSV);
    expect(r1).toMatchObject({ ok: true, spec: null, chartBy: null });
    expect(r1.ok && r1.note).toMatch(/so here is the table/);

    const prose = new FakeLlm((req) =>
      req.action === 'visualize_table' ? { columns: ['Quarter', 'Revenue'], rows: [['Q1', '$1.2M'], ['Q2', '$1.5M']] } : { spec_json: '' },
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
