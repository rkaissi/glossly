// Placeholder overlay for the shell milestone: renders the pill, the bar's slots, and the
// debug view so capture can be checked by hand. Step 4 replaces it with the real UI.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { OverlayState } from '@glossly/core/api';
import { glossly } from '../bridge';

const css = `
html, body { margin: 0; background: transparent; overflow: hidden; font: 13px system-ui, sans-serif; user-select: none; }
.box { display: inline-flex; flex-direction: column; gap: 6px; background: #1f1d2b; color: #f2f1f7; border-radius: 10px; padding: 6px; box-sizing: border-box; }
.row { display: flex; gap: 4px; }
button { background: #2e2b40; color: inherit; border: 0; border-radius: 6px; padding: 5px 10px; font: inherit; cursor: pointer; }
button:hover { background: #4b4570; }
button[disabled] { opacity: .5; }
.dot { width: 12px; height: 12px; margin: 2px; border-radius: 50%; background: #6d5ef5; }
pre { margin: 0; max-width: 440px; max-height: 160px; overflow: auto; white-space: pre-wrap; font: 11px ui-monospace, monospace; color: #b9b5d0; }
`;

function Overlay() {
  const [s, setS] = useState<OverlayState | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void glossly.invoke('overlay:get').then(setS);
    return glossly.on('overlay:state', setS);
  }, []);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !s || (s.mode !== 'bar' && s.mode !== 'panel')) return;
    const ro = new ResizeObserver(() => {
      void glossly.invoke('overlay:resize', { sessionId: s.sessionId, w: el.offsetWidth, h: el.offsetHeight });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [s?.sessionId, s?.mode]);

  if (!s || s.mode === 'hidden') return null;
  const id = s.sessionId;
  const expand = () => void glossly.invoke('bar:expand', { sessionId: id });
  if (s.mode === 'dot') return <div className="dot" onMouseEnter={expand} />;
  const run = (slot: 1 | 2 | 3 | 4) => void glossly.invoke('bar:run', { sessionId: id, slot });

  return (
    <div className="box" ref={ref} onMouseEnter={s.mode === 'pill' ? expand : undefined}>
      <div className="row">
        <button onClick={() => run(1)}>Ask</button>
        <button onClick={() => run(2)}>{s.slots?.slot2.label ?? 'Save'}</button>
        {s.slots?.slot3 && <button onClick={() => run(3)}>{s.slots.slot3.label}</button>}
        {s.slots?.slot4 && <button onClick={() => run(4)}>{s.slots.slot4.label}</button>}
        {s.mode !== 'pill' && <button onClick={() => void glossly.invoke('bar:close', { sessionId: id })}>×</button>}
      </div>
      {s.notice && <div>{s.notice}</div>}
      {s.mode === 'panel' && <div>Panel: {s.panel} (UI arrives in step 4)</div>}
      {s.mode !== 'pill' && s.debug && (
        <pre>
          {`${s.debug.method} · ${s.debug.trigger} · ${s.debug.source_app} · ${s.slots?.stage ?? ''} ${s.slots?.fallback ?? ''} ${s.slots?.content_type ?? ''}\n`}
          {`timings ${JSON.stringify(s.debug.timings)}\n`}
          {`«${s.debug.context_before.slice(-120)}[${s.debug.text.slice(0, 300)}]${s.debug.context_after.slice(0, 120)}»`}
        </pre>
      )}
    </div>
  );
}

const style = document.createElement('style');
style.textContent = css;
document.head.append(style);
createRoot(document.getElementById('root')!).render(<Overlay />);
