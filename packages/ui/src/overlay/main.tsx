// The overlay renderer: pill, dot, bar, and panels in one transparent window. Main owns the
// session and pushes OverlayState; this side only renders it and sends clicks and keys back.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { Badge, OverlayState, SlotView } from '@glossly/core/api';
import { glossly } from '../bridge';
import '../theme.css';
import './overlay.css';
import { AskPanel } from './AskPanel';
import { Debug } from './Debug';
import { barItems, barKey, sameItem, type BarItem } from './keys';
import { LaterPanel } from './LaterPanel';
import { SavePanel } from './SavePanel';

const expand = (sessionId: number) => void glossly.invoke('bar:expand', { sessionId });
const run = (sessionId: number, target: BarItem) => void glossly.invoke('bar:run', { sessionId, ...target });

const badgeLabel = (b: Badge) => (b.kind === 'recall' ? `${b.count} related` : b.label);

function Overlay() {
  const [s, setS] = useState<OverlayState | null>(null);

  useEffect(() => {
    let pushed = false;
    const off = glossly.on('overlay:state', (next) => {
      pushed = true;
      setS(next);
    });
    void glossly.invoke('overlay:get').then((first) => {
      if (!pushed) setS(first);
    });
    return off;
  }, []);

  if (!s || s.mode === 'hidden') return null;
  if (s.mode === 'dot') return <Dot s={s} />;
  if (s.mode === 'pill') return <Pill s={s} />;
  return <Expanded key={s.sessionId} s={s} />;
}

/**
 * Shown when toolbars sit both above and below the selection. Drawn at `placement.mark`
 * inside a larger click-through window; hovering it expands into the bar.
 */
function Dot({ s }: { s: OverlayState }) {
  const p = s.placement;
  const pos = p?.mark ? { left: p.mark.x - p.rect.x, top: p.mark.y - p.rect.y } : { left: 0, top: 0 };
  return <div className="dot" style={pos} title="Glossly" onMouseEnter={() => expand(s.sessionId)} />;
}

/** Ask and Save only. Hovering expands it into the bar; nothing is sent to a model yet. */
function Pill({ s }: { s: OverlayState }) {
  return (
    <div className={`pill${s.placement?.side === 'above' ? ' above' : ''}`} onMouseEnter={() => expand(s.sessionId)}>
      <button className="slot" onClick={() => run(s.sessionId, { slot: 1 })}>
        Ask
      </button>
      <button className="slot" onClick={() => run(s.sessionId, { slot: 2 })}>
        Save
      </button>
    </div>
  );
}

/** The bar, plus the open panel when mode is "panel". */
function Expanded({ s }: { s: OverlayState }) {
  const ref = useRef<HTMLDivElement>(null);
  const [highlight, setHighlight] = useState(0);
  const [moreOpen, setMoreOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const id = s.sessionId;
  const items = barItems(s.slots, s.hasSelection, moreOpen);
  const hl = Math.min(highlight, items.length - 1);

  // Main sizes the window; report the content's real size after every change.
  useLayoutEffect(() => {
    const el = ref.current;
    if (el) void glossly.invoke('overlay:resize', { sessionId: id, w: el.offsetWidth, h: el.offsetHeight });
  });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => void glossly.invoke('overlay:resize', { sessionId: id, w: el.offsetWidth, h: el.offsetHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, [id]);

  // The keyboard map is live only on the hotkey path (or once a panel has taken focus).
  useEffect(() => {
    if (!s.keyboard) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      if (s.mode === 'panel') {
        if (e.key === 'Escape') {
          e.preventDefault();
          void glossly.invoke('bar:back', { sessionId: id });
        }
        return;
      }
      const cmd = barKey({ key: e.key, ctrl: e.ctrlKey, alt: e.altKey, meta: e.metaKey, shift: e.shiftKey }, { items, highlight: hl, moreOpen });
      if (!cmd) return;
      e.preventDefault();
      if (cmd.kind === 'run') run(id, cmd.target);
      else if (cmd.kind === 'highlight') setHighlight(cmd.index);
      else if (cmd.kind === 'more') {
        // Opening More highlights its first item; closing it from there goes back to Ask.
        const closed = barItems(s.slots, s.hasSelection, false).length;
        setMoreOpen(cmd.open);
        if (!cmd.open) setHighlight((h) => (h >= closed ? 0 : h));
        else if (s.slots?.more.length) setHighlight(closed);
      } else void glossly.invoke('bar:close', { sessionId: id });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const slotButton = (target: BarItem, view: SlotView, opts: { fresh?: boolean; disabled?: boolean; hint?: string } = {}) => {
    const active = s.mode === 'panel' && s.panel === view.action;
    const cls = [
      'slot',
      opts.fresh && 'fresh',
      !view.available && 'later',
      s.keyboard && s.mode === 'bar' && sameItem(items[hl], target) && 'highlight',
      active && 'active',
    ]
      .filter(Boolean)
      .join(' ');
    const title = view.available ? view.label : `${view.label}: coming in a later phase`;
    return (
      <button
        key={'slot' in target ? `slot${target.slot}:${view.action}` : `more:${view.action}`}
        className={cls}
        title={view.score !== undefined ? `${title} (score ${view.score.toFixed(2)})` : title}
        disabled={opts.disabled}
        onClick={() => !active && run(id, target)}
      >
        {s.keyboard && opts.hint && <kbd>{opts.hint}</kbd>}
        <span>{view.label}</span>
      </button>
    );
  };

  const slots = s.slots;
  const ask: SlotView = slots?.slot1 ?? { action: 'ask', label: 'Ask', available: true };
  const save: SlotView = slots?.slot2 ?? { action: 'save', label: 'Save', available: true };
  const more = slots?.more ?? [];

  return (
    <div ref={ref} className={`frame${s.placement?.side === 'above' ? ' above' : ''}`}>
      <div className="row">
        {slotButton({ slot: 1 }, ask, { hint: '1' })}
        {slotButton({ slot: 2 }, save, { hint: '2', disabled: !s.hasSelection })}
        {slots?.slot3 && slotButton({ slot: 3 }, slots.slot3, { fresh: true, hint: '3' })}
        {slots?.slot4 && slotButton({ slot: 4 }, slots.slot4, { fresh: true, hint: '4' })}
        <span className="spacer" />
        {s.badges.map((b) => (
          <span key={b.kind === 'recall' ? 'recall' : b.personId} className="badge">
            {badgeLabel(b)}
          </span>
        ))}
        {s.hasSelection && more.length > 0 && (
          <button className="slot" title="More actions" onClick={() => setMoreOpen((o) => !o)}>
            {s.keyboard && <kbd>Tab</kbd>}
            <span>More</span>
          </button>
        )}
        <button className="icon" title="Options" onClick={() => setMenuOpen((o) => !o)}>
          ⋯
        </button>
        <button className="icon" title="Close" onClick={() => void glossly.invoke('bar:close', { sessionId: id })}>
          ✕
        </button>
      </div>

      {moreOpen && s.mode === 'bar' && (
        <div className="strip">
          {more.length > 0 ? (
            more.map((m) => slotButton({ action: m.action }, m))
          ) : (
            <span className="muted">No other actions fit this selection.</span>
          )}
        </div>
      )}

      {menuOpen && (
        <div className="strip">
          {s.siteKey && (
            <button
              title="Show the bar here only when you press the hotkey"
              onClick={() => void glossly.invoke('bar:dont-show-here', { sessionId: id })}
            >
              Don't show here ({s.siteKey})
            </button>
          )}
          <button onClick={() => void glossly.invoke('settings:open', {})}>Settings</button>
        </div>
      )}

      {s.notice && <div className="strip notice">{s.notice}</div>}
      {!s.hasSelection && !s.notice && (
        <div className="strip muted">Nothing selected. Ask a question, or select text and press the hotkey again.</div>
      )}

      {s.mode === 'panel' &&
        s.panel &&
        (s.panel === 'ask' ? (
          <AskPanel key="ask" s={s} />
        ) : s.panel === 'save' ? (
          <SavePanel key="save" s={s} />
        ) : (
          <LaterPanel key={s.panel} action={s.panel} sessionId={id} keyboard={s.keyboard} />
        ))}

      {s.debug && <Debug d={s.debug} slots={slots} />}
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<Overlay />);
