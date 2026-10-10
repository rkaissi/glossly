// Visualize, step 1 (spec): read the selection as a table when its shape says how. Markdown
// tables, TSV, CSV (with quotes), semicolons, pipes, and columns aligned with spaces.
import type { Cell, FieldType, ParsedTable, TableSource } from './types';

const MAX_ROWS = 500;
const MAX_COLS = 20;

const MD_SEPARATOR = /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)*\|?\s*$/;

/** Splits one delimited line, honoring double quotes ("a, b" stays one cell; "" is a quote). */
export function splitDelimited(line: string, delim: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cur += c;
    } else if (c === '"' && cur.trim() === '') {
      quoted = true;
      cur = '';
    } else if (c === delim) {
      out.push(cur.trim());
      cur = '';
    } else cur += c;
  }
  out.push(cur.trim());
  return out;
}

function markdownRows(lines: string[]): string[][] | null {
  const sep = lines.findIndex((l) => MD_SEPARATOR.test(l));
  if (sep !== 1 || !lines[0]!.includes('|')) return null;
  const cells = (l: string) => {
    const parts = l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|');
    return parts.map((p) => p.trim());
  };
  return [cells(lines[0]!), ...lines.slice(2).filter((l) => l.includes('|')).map(cells)];
}

/** A delimiter that splits most lines into the same number (2 or more) of cells. */
function delimitedRows(lines: string[]): { rows: string[][]; source: TableSource } | null {
  const tries: [string, TableSource][] = [
    ['\t', 'tsv'],
    [',', 'csv'],
    [';', 'semicolon'],
    ['|', 'pipe'],
  ];
  for (const [delim, source] of tries) {
    const rows = lines.map((l) => splitDelimited(l, delim));
    const width = rows[0]!.length;
    if (width < 2) continue;
    const same = rows.filter((r) => r.length === width).length;
    if (same >= Math.max(2, Math.ceil(rows.length * 0.8))) return { rows: rows.filter((r) => r.length === width), source };
  }
  return null;
}

function alignedRows(lines: string[]): string[][] | null {
  const rows = lines.map((l) => l.trim().split(/\s{2,}/));
  const width = rows[0]!.length;
  if (width < 2) return null;
  const same = rows.filter((r) => r.length === width).length;
  return same >= Math.max(2, Math.ceil(rows.length * 0.8)) ? rows.filter((r) => r.length === width) : null;
}

const MULTIPLIER: Record<string, number> = { k: 1e3, m: 1e6, b: 1e9 };

/** "1,234", "$4.2M", "40%", "(12)", "−3.5" as numbers; anything else is null. */
export function parseNumber(raw: string): number | null {
  let s = raw.trim().replace(/[−‒–]/g, '-');
  if (!s) return null;
  let negative = false;
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1);
  }
  s = s.replace(/^[+]/, '').replace(/^([-]?)[$€£¥]/, '$1').replace(/%$/, '').trim();
  const m = /^(-?)(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?\s*([kKmMbB])?$/.exec(s) ?? /^(-?)()(\.\d+)\s*([kKmMbB])?$/.exec(s);
  if (!m) return null;
  const n = Number(`${m[1]}${m[2]!.replace(/,/g, '') || '0'}${m[3] ?? ''}`) * (m[4] ? MULTIPLIER[m[4].toLowerCase()]! : 1);
  if (!Number.isFinite(n)) return null;
  return negative ? -n : n;
}

/** Field names Vega-Lite reads literally: no dots, brackets, or quotes, never empty, unique. */
export function safeColumns(names: string[]): string[] {
  const seen = new Map<string, number>();
  return names.map((raw, i) => {
    const base = raw.replace(/[.[\]\\"']/g, ' ').replace(/\s+/g, ' ').trim() || `Column ${i + 1}`;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return n === 1 ? base : `${base} ${n}`;
  });
}

/** Builds the table from string rows: header detection, numbers, and padding. */
export function toTable(raw: string[][], source: TableSource, given?: string[]): ParsedTable | null {
  if (given) raw = [given, ...raw];
  const width = Math.min(MAX_COLS, Math.max(...raw.map((r) => r.length)));
  if (width < 2) return null;
  const pad = (r: string[]) => Array.from({ length: width }, (_, i) => r[i] ?? '');
  const rows = raw.map(pad);
  // The first row is a header unless it looks like data: a number where the rest of that column has numbers.
  const first = rows[0]!;
  const body = rows.slice(1);
  const looksLikeData = !given && first.some((c, i) => parseNumber(c) !== null && body.length > 0 && body.every((r) => parseNumber(r[i]!) !== null || !r[i]));
  const header = looksLikeData ? first.map((_, i) => `Column ${i + 1}`) : first;
  const data = (looksLikeData ? rows : body).slice(0, MAX_ROWS);
  if (data.length < 2) return null;
  const cells: Cell[][] = data.map((r) => r.map((c) => (c === '' ? null : (parseNumber(c) ?? c))));
  return { columns: safeColumns(header), rows: cells, source };
}

/** The selection as a table, or null when its shape doesn't say how to read it. */
export function parseTable(text: string): ParsedTable | null {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+$/, ''))
    .filter((l) => l.trim());
  if (lines.length < 3) return null;
  const md = markdownRows(lines);
  if (md) return toTable(md, 'markdown');
  const delimited = delimitedRows(lines);
  if (delimited) return toTable(delimited.rows, delimited.source);
  const aligned = alignedRows(lines);
  return aligned ? toTable(aligned, 'aligned') : null;
}

const MONTH = /^(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?(\s+\d{2,4})?$/i;
const ISO_DATE = /^\d{4}-\d{2}(-\d{2})?$/;

/** Measurement type per column: numbers, dates (ISO or month names), years as ordinal, else nominal. */
export function inferTypes(table: ParsedTable): FieldType[] {
  return table.columns.map((_, i) => {
    const values = table.rows.map((r) => r[i]).filter((v): v is string | number => v !== null);
    if (values.length === 0) return 'nominal';
    if (values.every((v) => typeof v === 'number')) {
      const years = (values as number[]).every((v) => Number.isInteger(v) && v >= 1900 && v <= 2100);
      return years && i === 0 ? 'ordinal' : 'quantitative';
    }
    const strings = values.map(String);
    if (strings.every((v) => ISO_DATE.test(v))) return 'temporal';
    if (strings.every((v) => MONTH.test(v))) return 'ordinal';
    return 'nominal';
  });
}

/** CSV for "Copy table as CSV". */
export function toCsv(table: ParsedTable): string {
  const cell = (v: Cell) => {
    const s = v === null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [table.columns.map(cell).join(','), ...table.rows.map((r) => r.map(cell).join(','))].join('\n');
}
