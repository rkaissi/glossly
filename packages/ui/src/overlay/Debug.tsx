import { useState } from 'react';
import type { PillTiming, SelectionDebug, SlotsView } from '@glossly/core/api';

const OPEN_KEY = 'glossly.debugOpen';
const clip = (s: string, n: number, fromEnd = false) => (s.length <= n ? s : fromEnd ? `…${s.slice(-n)}` : `${s.slice(0, n)}…`);

/** e.g. "shown at 131 ms · wait 100 ms (short) · 1 check, last 22 ms · toolbar found". */
function pillLine(p: PillTiming, t: Record<string, number>): string {
  return [
    t.total !== undefined && `shown at ${t.total} ms`,
    `wait ${p.wait_ms} ms (${p.reason})`,
    `${p.polls} ${p.polls === 1 ? 'check' : 'checks'}${t.popups_near !== undefined ? `, last ${t.popups_near} ms` : ''}`,
    p.found && 'toolbar found',
    !p.baseline && 'no baseline',
  ]
    .filter(Boolean)
    .join(' · ');
}

/** Captured text, method, timings, routing, and tier-1 context. Shown when settings.debugView is on. */
export function Debug({ d, slots }: { d: SelectionDebug; slots: SlotsView | null }) {
  const [open, setOpen] = useState(() => localStorage.getItem(OPEN_KEY) !== '0');
  const route = slots
    ? [slots.stage, slots.provider, slots.content_type, slots.fallback && `fallback ${slots.fallback}`, slots.route_ms !== null && `${slots.route_ms} ms`]
        .filter(Boolean)
        .join(' · ')
    : 'not routed';
  const timings = Object.entries(d.timings)
    .map(([k, v]) => `${k} ${v}`)
    .join(' · ');

  return (
    <details
      className="debug"
      open={open}
      onToggle={(e) => {
        const o = (e.currentTarget as HTMLDetailsElement).open;
        setOpen(o);
        localStorage.setItem(OPEN_KEY, o ? '1' : '0');
      }}
    >
      <summary>
        debug: {d.method} · {d.trigger} · {d.source_app || 'unknown app'}
        {d.is_editable ? ' · editable' : ''}
      </summary>
      <div>route: {route}</div>
      <div>timings: {timings || 'none'}</div>
      {d.pill && (
        <div>
          pill wait: {pillLine(d.pill, d.timings)}
        </div>
      )}
      {d.placement && (
        <div>
          pill: {d.placement === 'end' ? 'dot' : d.placement} · obstacles: {d.obstacles.length === 0 && 'none'}
          {d.obstacles.map((o, i) => (
            <div key={i} className={o.status === 'new' ? undefined : 'ignored'}>
              {`${o.side} ${o.source} ${o.kind} ${o.w}×${o.h} · ${o.status} · ${o.process_name} ${clip(o.class_name, 40)}`}
            </div>
          ))}
        </div>
      )}
      <div>title: {clip(d.window_title, 120)}</div>
      <div className="ctx">
        {clip(d.context_before, 500, true)}
        <mark>{clip(d.text, 1500) || '(no selection)'}</mark>
        {clip(d.context_after, 500)}
        {!d.context_before && !d.context_after && <span>{'\n'}(no tier-1 context)</span>}
      </div>
    </details>
  );
}
