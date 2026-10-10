import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Check, Info, Undo2 } from 'lucide-react';
import type { OverlayState } from '@glossly/core/api';
import { glossly } from '../bridge';

/** Seconds left until `until` (epoch ms), ticking; 0 once it has passed. */
export function useSecondsLeft(until: number | null | undefined): number {
  const [left, setLeft] = useState(0);
  useEffect(() => {
    if (!until) {
      setLeft(0);
      return;
    }
    const tick = () => setLeft(Math.max(0, Math.ceil((until - Date.now()) / 1000)));
    tick();
    const t = setInterval(tick, 250);
    return () => clearInterval(t);
  }, [until]);
  return left;
}

/**
 * After the save hotkey: "Saved to Notes" with Undo. Shown without focus, so typing stays in
 * the app; it goes away when the undo window ends, on a click elsewhere, or on a scroll.
 */
export function SavedToast({ s }: { s: OverlayState }) {
  const ref = useRef<HTMLDivElement>(null);
  const left = useSecondsLeft(s.saved?.undoUntil);
  const [busy, setBusy] = useState(false);

  useLayoutEffect(() => {
    const el = ref.current;
    if (el) void glossly.invoke('overlay:resize', { sessionId: s.sessionId, w: el.offsetWidth, h: el.offsetHeight });
  });

  return (
    <div ref={ref} className={`toast row${s.placement?.side === 'above' ? ' above' : ''}`}>
      {s.saved ? (
        <>
          <Check size={16} strokeWidth={2} aria-hidden />
          <span className="toast-text">Saved to {s.saved.collection}</span>
          {left > 0 && (
            <button
              className="ghost"
              disabled={busy}
              onClick={() => {
                setBusy(true);
                void glossly.invoke('saved:undo', { sessionId: s.sessionId }).finally(() => setBusy(false));
              }}
            >
              <Undo2 size={14} strokeWidth={1.75} aria-hidden />
              Undo ({left}s)
            </button>
          )}
        </>
      ) : (
        <>
          <Info size={16} strokeWidth={1.75} aria-hidden />
          <span className="toast-text">{s.notice}</span>
        </>
      )}
    </div>
  );
}
