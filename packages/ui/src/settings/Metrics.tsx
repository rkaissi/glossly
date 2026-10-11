import { useEffect, useState } from 'react';
import type { MetricsSummary } from '@glossly/core/api';
import { glossly } from '../bridge';
import { pct } from './format';
import { useAction } from './useAction';

const ACTION_NAMES: Record<string, string> = {
  ask: 'Ask',
  save: 'Save',
  reply: 'Reply',
  who: 'Who is this',
  promises: 'What did I promise',
  visualize: 'Visualize',
  search: 'Search',
  recall: 'Related',
  paste_list: 'Paste snippets',
  paste_summary: 'Write it for here',
};
const SAVE_VIA: Record<string, string> = { panel: 'Save panel', hotkey: 'Save hotkey', autosave: 'Autosave', ask: 'Ask', visualize: 'Visualize' };
const RANGES = [7, 30, 90];

export function MetricsTab() {
  const [days, setDays] = useState(7);
  const [m, setM] = useState<MetricsSummary | null>(null);
  const { error, run } = useAction();

  useEffect(() => {
    let live = true;
    void run(() => glossly.invoke('metrics:summary', { days })).then((r) => live && r && setM(r));
    return () => {
      live = false;
    };
  }, [days, run]);

  const actions = m ? Object.entries(m.actions).sort(([, a], [, b]) => b.clicks - a.clicks) : [];
  const actionCols = [...new Set(m?.days.flatMap((d) => Object.keys(d.actions)) ?? [])].sort();
  const name = (a: string) => ACTION_NAMES[a] ?? a;
  const activeDays = m ? [...m.days].reverse().filter((d) => d.hotkey + d.pill_shown + d.bar_shown + Object.keys(d.actions).length > 0) : [];

  return (
    <section>
      <div className="row">
        <h2 className="grow">Metrics</h2>
        <select value={days} aria-label="Time range" onChange={(e) => setDays(Number(e.target.value))}>
          {RANGES.map((d) => (
            <option key={d} value={d}>
              Last {d} days
            </option>
          ))}
        </select>
      </div>
      <p className="muted">Counted on this computer only. Nothing is sent anywhere; export from the Data tab to share them.</p>
      {error && <p className="error">{error}</p>}
      {m && (
        <>
          <div className="stats">
            <Stat label="Hotkey presses" value={m.totals.hotkey} />
            <Stat label="Pills shown" value={m.totals.pill_shown} />
            <Stat label="Bars opened" value={m.totals.bar_shown} />
            <Stat label="Pill to bar" value={m.totals.pill_shown ? pct(m.expand_rate) : '–'} />
          </div>

          <h3>Actions</h3>
          {actions.length === 0 ? (
            <p className="muted">No actions yet.</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Action</th>
                  <th className="num">Clicks</th>
                  <th className="num">Click rate</th>
                  <th className="num">Median time to click</th>
                </tr>
              </thead>
              <tbody>
                {actions.map(([a, s]) => (
                  <tr key={a}>
                    <td>{name(a)}</td>
                    <td className="num">{s.clicks}</td>
                    <td className="num">{pct(s.click_rate)}</td>
                    <td className="num">{s.median_ms === null ? '–' : `${(s.median_ms / 1000).toFixed(1)} s`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <p className="muted small">Click rate is clicks divided by triggers (hotkey presses plus pills shown).</p>

          <h3>Features</h3>
          <Features m={m} />

          <h3>By day</h3>
          {activeDays.length === 0 ? (
            <p className="muted">No activity in this range.</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Date</th>
                  <th className="num">Hotkey</th>
                  <th className="num">Pills</th>
                  <th className="num">Bars</th>
                  {actionCols.map((a) => (
                    <th key={a} className="num">
                      {name(a)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {activeDays.map((d) => (
                  <tr key={d.date}>
                    <td>{d.date}</td>
                    <td className="num">{d.hotkey}</td>
                    <td className="num">{d.pill_shown}</td>
                    <td className="num">{d.bar_shown}</td>
                    {actionCols.map((a) => (
                      <td key={a} className="num">
                        {d.actions[a] ?? 0}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </section>
  );
}

/** How the Phase 2 and 3 features were used: saves, Recall, Reply's outcomes, paste, promises, and model errors. */
function Features({ m }: { m: MetricsSummary }) {
  const f = m.features;
  const saves = Object.entries(f.saves).sort(([, a], [, b]) => b - a);
  const savedTotal = saves.reduce((n, [, c]) => n + c, 0);
  const unedited = f.reply.inserted - f.reply.edited;
  const rows: [string, string | number][] = [
    ['Saved', savedTotal ? `${savedTotal} (${saves.map(([via, n]) => `${SAVE_VIA[via] ?? via} ${n}`).join(', ')})` : 0],
    ['Undone right after saving', f.undone],
    ['Related badge shown / opened / "Not related"', `${f.recall.shown} / ${f.recall.opened} / ${f.recall.dismissed}`],
    ['Reply draft sets written', f.reply.drafts],
    ['Reply inserted unedited / edited / own', `${unedited} / ${f.reply.edited - f.reply.own} / ${f.reply.own}`],
    ['Reply copied / discarded / "None of these"', `${f.reply.copied} / ${f.reply.discarded} / ${f.reply.redo}`],
    ['Paste composed / pasted', `${f.paste.composed} / ${f.paste.inserted}`],
    ['Search results typed in', f.search.inserted],
    ['Promises looked for / saved', `${f.promises.extracted} / ${f.promises.saved}`],
    ['Model calls that failed / switched to a fallback', `${f.errors} / ${f.fallbacks}`],
  ];
  return (
    <table>
      <tbody>
        {rows.map(([label, value]) => (
          <tr key={label}>
            <td>{label}</td>
            <td className="num">{value}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Stat({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="stat">
      <div className="stat-value">{value}</div>
      <div className="muted small">{label}</div>
    </div>
  );
}
