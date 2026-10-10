import { useEffect, useRef, useState } from 'react';
import { Check, Copy, Image as ImageIcon, RotateCcw, Table, Undo2 } from 'lucide-react';
import type { Cell, FieldType, OverlayState, SaveDone, VisualizeResult } from '@glossly/core/api';
import { glossly } from '../bridge';
import { ActionIcon } from '../icons';
import { useSecondsLeft } from './SavedToast';

type View = { toImageURL(type: string, scale?: number): Promise<string> };

/**
 * Series colors for two or more series (the dataviz reference palette, validated for both
 * modes and color-vision deficiency). A single series uses the ink color, so the app stays
 * monochrome (decision 13) unless color has to tell series apart.
 */
const SERIES = {
  light: ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6', '#e34948'],
  dark: ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'],
};

/** Vega-Lite config from the app's tokens: thin marks, recessive axes and grid, text in ink, not series colors. */
function chartConfig(): Record<string, unknown> {
  const css = getComputedStyle(document.documentElement);
  const v = (name: string) => css.getPropertyValue(name).trim();
  const dark = matchMedia('(prefers-color-scheme: dark)').matches;
  const ink = v('--fg');
  const ink2 = v('--fg-2');
  const font = v('--font') || 'Segoe UI, sans-serif';
  return {
    background: 'transparent',
    font,
    view: { stroke: null },
    axis: {
      labelColor: ink2,
      titleColor: ink2,
      labelFontSize: 11,
      titleFontSize: 11,
      titleFontWeight: 500,
      gridColor: v('--border'),
      domainColor: v('--border-strong'),
      tickColor: v('--border-strong'),
      labelLimit: 120,
    },
    legend: { labelColor: ink2, titleColor: ink2, labelFontSize: 11, titleFontSize: 11, orient: 'top', symbolType: 'circle' },
    range: { category: dark ? SERIES.dark : SERIES.light },
    mark: { color: ink },
    bar: { cornerRadiusEnd: 4, stroke: 'transparent' },
    line: { strokeWidth: 2 },
    point: { size: 64, filled: true },
    area: { opacity: 0.85 },
  };
}

function TableView({ columns, rows, types }: { columns: string[]; rows: Cell[][]; types: FieldType[] }) {
  return (
    <div className="viz-table">
      <table>
        <thead>
          <tr>
            {columns.map((c, i) => (
              <th key={c} className={types[i] === 'quantitative' ? 'num' : undefined}>
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              {r.map((c, j) => (
                <td key={j} className={typeof c === 'number' ? 'num' : undefined}>
                  {c === null ? '' : typeof c === 'number' ? c.toLocaleString('en-US') : c}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Visualize (spec): the selection as a chart, with a table view, Copy as image, Copy table as CSV, and Save. */
export function VisualizePanel({ s }: { s: OverlayState }) {
  const [result, setResult] = useState<VisualizeResult | null>(null);
  const [showTable, setShowTable] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [saved, setSaved] = useState<(SaveDone & { undone?: boolean }) | null>(null);
  const chartEl = useRef<HTMLDivElement>(null);
  const view = useRef<View | null>(null);
  const undoLeft = useSecondsLeft(saved && !saved.undone ? saved.undoUntil : null);

  const run = async () => {
    setResult(null);
    setNote(null);
    setResult(await glossly.invoke('visualize:run', { sessionId: s.sessionId }));
  };

  useEffect(() => {
    void run();
    // One run per panel; the session id never changes inside it.
  }, []);

  const spec = result?.ok ? result.spec : null;
  const chartShown = Boolean(spec) && !showTable;

  useEffect(() => {
    if (!spec || !chartShown || !chartEl.current) return;
    let finalize: (() => void) | null = null;
    let live = true;
    void Promise.all([import('vega-embed'), import('vega-interpreter')])
      .then(async ([{ default: embed }, { expressionInterpreter }]) => {
        if (!live || !chartEl.current) return;
        const dark = matchMedia('(prefers-color-scheme: dark)').matches;
        const r = await embed(chartEl.current, { ...spec, config: chartConfig() } as never, {
          actions: false,
          renderer: 'svg',
          tooltip: { theme: dark ? 'dark' : 'light' },
          // The page's CSP forbids eval, so expressions run through vega's interpreter instead of new Function.
          ast: true,
          expr: expressionInterpreter,
        });
        if (!live) {
          r.finalize();
          return;
        }
        view.current = r.view;
        finalize = () => r.finalize();
      })
      .catch(() => {
        if (!live) return;
        setShowTable(true);
        setNote("The chart couldn't be drawn, so here is the table.");
      });
    return () => {
      live = false;
      view.current = null;
      finalize?.();
    };
  }, [spec, chartShown]);

  const copyImage = async () => {
    if (!view.current) return;
    const url = await view.current.toImageURL('png', 2);
    await glossly.invoke('clipboard:image', { dataUrl: url });
    setNote('Chart copied as an image.');
  };
  const copyCsv = () => {
    if (!result?.ok) return;
    void glossly.invoke('clipboard:write', { text: result.csv });
    setNote('Table copied as CSV.');
  };
  const save = async () => {
    try {
      setSaved(await glossly.invoke('visualize:save', { sessionId: s.sessionId }));
    } catch {
      setNote('Could not save. Try again.');
    }
  };
  const turnOffLocalOnly = async () => {
    const r = await glossly.invoke('settings:set', { key: 'localOnly', value: false });
    if (!r.error) await run();
  };

  return (
    <div className="panel visualize">
      <h2 className="saved-line">
        <ActionIcon action="visualize" size={17} />
        <span>
          Visualize
          {result?.ok && (
            <span className="muted">
              {' '}
              · {result.table.rows.length} rows{result.table.source === 'model' ? ', read by the model' : ''}
            </span>
          )}
        </span>
      </h2>

      {!result && <p className="muted">Reading the table…</p>}
      {result && !result.ok && (
        <div className="answer-error">
          <span className={result.code === 'no_table' ? 'muted' : 'error'}>{result.message}</span>
          {result.code === 'no_model' && <button onClick={() => void glossly.invoke('settings:open', { tab: 'keys' })}>Add a key</button>}
          {result.code === 'local_only' && <button onClick={() => void turnOffLocalOnly()}>Turn off Local only and try</button>}
          {(result.code === 'provider' || result.code === 'timeout' || result.code === 'invalid_output') && (
            <button onClick={() => void run()}>
              <RotateCcw size={14} strokeWidth={1.75} aria-hidden />
              Try again
            </button>
          )}
        </div>
      )}
      {result?.ok && result.note && <p className="muted small-text">{result.note}</p>}
      {result?.ok && result.chartBy === 'rules' && !result.note && <p className="muted small-text">A plain chart picked by rules, since no model is used.</p>}
      {chartShown && <div ref={chartEl} className="viz-chart" />}
      {result?.ok && (!spec || showTable) && <TableView columns={result.table.columns} rows={result.table.rows} types={result.types} />}

      {(note || saved) && (
        <div className="inline-note">
          <Check size={14} strokeWidth={2} aria-hidden />
          <span>{saved ? (saved.undone ? `Removed from ${saved.collection}.` : `Saved to ${saved.collection}.`) : note}</span>
          {saved && !saved.undone && undoLeft > 0 && (
            <button
              className="ghost"
              onClick={() => void glossly.invoke('save:undo', { itemId: saved.itemId }).then((r) => r.undone && setSaved({ ...saved, undone: true }))}
            >
              <Undo2 size={14} strokeWidth={1.75} aria-hidden />
              Undo ({undoLeft}s)
            </button>
          )}
        </div>
      )}

      <div className="panel-foot">
        {result?.ok && spec && (
          <button className="ghost" onClick={() => setShowTable((t) => !t)}>
            <Table size={14} strokeWidth={1.75} aria-hidden />
            {showTable ? 'Chart' : 'Table'}
          </button>
        )}
        <span className="spacer" />
        {result?.ok && (
          <>
            {chartShown && (
              <button className="ghost" onClick={() => void copyImage()}>
                <ImageIcon size={14} strokeWidth={1.75} aria-hidden />
                Copy as image
              </button>
            )}
            <button className="ghost" onClick={copyCsv}>
              <Copy size={14} strokeWidth={1.75} aria-hidden />
              Copy CSV
            </button>
            <button className="primary" disabled={Boolean(saved && !saved.undone)} onClick={() => void save()}>
              Save
            </button>
          </>
        )}
        {s.keyboard && (
          <span>
            <kbd>Esc</kbd> back
          </span>
        )}
      </div>
    </div>
  );
}
