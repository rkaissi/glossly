// Types shared with the UI (through api.ts). No runtime code.

export type Cell = string | number | null;

/** How the table was read: deterministically by its shape, or by the model. */
export type TableSource = 'markdown' | 'tsv' | 'csv' | 'semicolon' | 'pipe' | 'aligned' | 'model';

export interface ParsedTable {
  /** Column names, safe to use as Vega-Lite field names (no dots or brackets), unique. */
  columns: string[];
  rows: Cell[][];
  source: TableSource;
}

/** Vega-Lite measurement types, inferred per column. Years are ordinal, not timestamps. */
export type FieldType = 'quantitative' | 'temporal' | 'ordinal' | 'nominal';

export type VisualizeResult =
  | {
      ok: true;
      table: ParsedTable;
      types: FieldType[];
      /** A validated Vega-Lite spec with the rows inlined, or null to show the table. */
      spec: Record<string, unknown> | null;
      /** Who picked the chart: the model, or code (Local only, no key, or the model's spec failed). */
      chartBy: 'model' | 'rules' | null;
      /** One line for the panel, e.g. why the table is shown instead of a chart. */
      note: string | null;
      csv: string;
      /** Why the model's spec was refused (a code such as "schema" or "unknown_field"), for the log. */
      rejected?: string;
    }
  | { ok: false; code: 'no_table' | 'no_selection' | 'local_only' | 'no_model' | 'provider' | 'invalid_output' | 'aborted' | 'timeout'; message: string };
