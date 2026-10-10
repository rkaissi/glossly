// The overlay renderer: pill, dot, bar, and panels in one window. Main owns the session and
// pushes OverlayState; this side only renders it and sends clicks and keys back.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Check, EyeOff, History, Info, Settings, Undo2, UserRound, X } from 'lucide-react';
import type { Badge, OverlayState, SlotView } from '@glossly/core/api';
import { glossly } from '../bridge';
import { ActionIcon, GlosslyMark } from '../icons';
import '../theme.css';
import './overlay.css';
import { AskPanel } from './AskPanel';
import { Debug } from './Debug';
import { barItems, barKey, sameItem, type BarItem } from './keys';
import { LaterPanel } from './LaterPanel';
import { PastePanel } from './PastePanel';
import { PromisesPanel } from './PromisesPanel';
import { RecallPanel } from './RecallPanel';
import { ReplyPanel } from './ReplyPanel';
import { SavePanel } from './SavePanel';
import { SavedToast, useSecondsLeft } from './SavedToast';
import { SearchPanel } from './SearchPanel';
import { WhoPanel } from './WhoPanel';

// Main loads the page with ?material=acrylic when the window is Windows 11 acrylic glass.
document.documentElement.dataset.material = new URLSearchParams(location.search).get('material') ?? 'none';

const expand = (sessionId: number) => void glossly.invoke('bar:expand', { sessionId });
const run = (sessionId: number, target: BarItem) => void glossly.invoke('bar:run', { sessionId, ...target });

const badgeLabel = (b: Badge) => (b.kind === 'recall' ? `${b.count} related` : b.label);

/** Set when the pill's menu button is clicked: the bar it expands into opens with the menu. */
let openMenuOnExpand = false;

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

  // The glass tint covers the whole window, except in dot mode (a clear window with a small circle).
  useLayoutEffect(() => {
    document.body.dataset.mode = s?.mode ?? 'hidden';
  }, [s?.mode]);

  if (!s || s.mode === 'hidden') return null;
  if (s.mode === 'dot') return <Dot s={s} />;
  if (s.mode === 'pill') return <Pill s={s} />;
  if (s.mode === 'toast') return <SavedToast s={s} />;
  return <Expanded key={s.sessionId} s={s} />;
}

/**
 * Shown when toolbars sit both above and below the selection. Drawn at `placement.mark`
 * inside a larger click-through window; hovering it expands into the bar.
 */
function Dot({ s }: { s: OverlayState }) {
  const p = s.placement;
  const pos = p?.mark ? { left: p.mark.x - p.rect.x, top: p.mark.y - p.rect.y } : { left: 0, top: 0 };
  return (
    <div className="dot" style={pos} title="Glossly" onMouseEnter={() => expand(s.sessionId)}>
      <GlosslyMark size={12} />
    </div>
  );
}

function MenuButton({ open, onClick }: { open: boolean; onClick: () => void }) {
  return (
    <button className={`menu-btn${open ? ' open' : ''}`} title="Glossly menu" aria-haspopup="menu" aria-expanded={open} onClick={onClick}>
      <GlosslyMark />
    </button>
  );
}

/** The menu, Ask, and Save. Hovering expands it into the bar; nothing is sent to a model yet. */
function Pill({ s }: { s: OverlayState }) {
  return (
    <div className={`pill row${s.placement?.side === 'above' ? ' above' : ''}`} onMouseEnter={() => expand(s.sessionId)}>
      <MenuButton
        open={false}
        onClick={() => {
          openMenuOnExpand = true;
          expand(s.sessionId);
        }}
      />
      <button className="slot ask" onClick={() => run(s.sessionId, { slot: 1 })}>
        <ActionIcon action="ask" />
        <span>Ask</span>
      </button>
      {s.saved ? (
        // Autosave: already saved. The bar it expands into offers Undo.
        <button className="slot save" title={`Saved to ${s.saved.collection}`} onClick={() => expand(s.sessionId)}>
          <Check size={16} strokeWidth={2} aria-hidden />
          <span>Saved</span>
        </button>
      ) : (
        <button className="slot save" onClick={() => run(s.sessionId, { slot: 2 })}>
          <ActionIcon action="save" />
          <span>Save</span>
        </button>
      )}
    </div>
  );
}

/** The bar, plus the open panel when mode is "panel". */
function Expanded({ s }: { s: OverlayState }) {
  const ref = useRef<HTMLDivElement>(null);
  const [highlight, setHighlight] = useState(0);
  const [menuOpen, setMenuOpen] = useState(() => {
    const open = openMenuOnExpand;
    openMenuOnExpand = false;
    return open;
  });
  const id = s.sessionId;
  const items = barItems(s.slots, s.hasSelection, menuOpen);
  const undoLeft = useSecondsLeft(s.saved?.undoUntil);
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

  const toggleMenu = (open: boolean) => {
    // Opening with Tab highlights More's first item; closing from there goes back to Ask.
    const closed = barItems(s.slots, s.hasSelection, false).length;
    setMenuOpen(open);
    if (!open) setHighlight((h) => (h >= closed ? 0 : h));
    else if (s.keyboard && s.hasSelection && s.slots?.more.length) setHighlight(closed);
  };

  // The keyboard map is live only on the hotkey path (or once a panel has taken focus).
  useEffect(() => {
    if (!s.keyboard) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      if (s.mode === 'panel') {
        if (e.key === 'Escape') {
          e.preventDefault();
          if (menuOpen) setMenuOpen(false);
          else void glossly.invoke('bar:back', { sessionId: id });
        }
        return;
      }
      const cmd = barKey({ key: e.key, ctrl: e.ctrlKey, alt: e.altKey, meta: e.metaKey, shift: e.shiftKey }, { items, highlight: hl, menuOpen });
      if (!cmd) return;
      e.preventDefault();
      if (cmd.kind === 'run') {
        setMenuOpen(false);
        run(id, cmd.target);
      } else if (cmd.kind === 'highlight') setHighlight(cmd.index);
      else if (cmd.kind === 'menu') toggleMenu(cmd.open);
      else void glossly.invoke('bar:close', { sessionId: id });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const isHighlighted = (target: BarItem) => s.keyboard && s.mode === 'bar' && sameItem(items[hl], target);
  const titleFor = (view: SlotView) => {
    const title = view.available ? view.label : `${view.label}: coming in a later phase`;
    return view.score !== undefined ? `${title} (score ${view.score.toFixed(2)})` : title;
  };

  const slotButton = (target: { slot: 1 | 2 | 3 | 4 }, view: SlotView, opts: { cls?: string; fresh?: boolean; disabled?: boolean } = {}) => {
    const active = s.mode === 'panel' && s.panel === view.action;
    const cls = ['slot', opts.cls, opts.fresh && 'fresh', !view.available && 'later', isHighlighted(target) && 'highlight', active && 'active']
      .filter(Boolean)
      .join(' ');
    return (
      <button
        key={`slot${target.slot}:${view.action}`}
        className={cls}
        title={titleFor(view)}
        disabled={opts.disabled}
        onClick={() => !active && run(id, target)}
      >
        {/* The number takes the icon's 16 px, so turning the keyboard map on moves nothing. */}
        {s.keyboard ? <kbd>{target.slot}</kbd> : <ActionIcon action={view.action} />}
        <span>{view.label}</span>
      </button>
    );
  };

  const slots = s.slots;
  const ask: SlotView = slots?.slot1 ?? { action: 'ask', label: 'Ask', available: true };
  const save: SlotView = slots?.slot2 ?? { action: 'save', label: 'Save', available: true };
  const more = slots?.more ?? [];
  const strip = Boolean(s.notice) || (!s.hasSelection && s.panel !== 'search');
  const frameCls = [
    'frame',
    s.placement?.side === 'above' && 'above',
    menuOpen && 'has-menu',
    strip && 'has-strip',
    s.debug && 'has-debug',
    s.mode === 'panel' && 'has-panel',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div ref={ref} className={frameCls}>
      <div className="row">
        <MenuButton open={menuOpen} onClick={() => toggleMenu(!menuOpen)} />
        {slotButton({ slot: 1 }, ask, { cls: 'ask' })}
        {/* Nothing selected: nothing to save, so Search and the paste actions sit next to Ask. */}
        {s.hasSelection && !s.saved && slotButton({ slot: 2 }, save, { cls: 'save' })}
        {s.hasSelection && s.saved && (
          // Already saved (autosave): slot 2 undoes it while the undo window lasts.
          <button
            key="slot2:saved"
            className={['slot save', isHighlighted({ slot: 2 }) && 'highlight'].filter(Boolean).join(' ')}
            title={undoLeft > 0 ? `Undo: remove it from ${s.saved.collection}` : `Saved to ${s.saved.collection}`}
            disabled={undoLeft === 0}
            onClick={() => run(id, { slot: 2 })}
          >
            {s.keyboard && undoLeft > 0 ? <kbd>2</kbd> : undoLeft > 0 ? <Undo2 size={16} strokeWidth={1.75} aria-hidden /> : <Check size={16} strokeWidth={2} aria-hidden />}
            <span>{undoLeft > 0 ? `Undo save (${undoLeft}s)` : `Saved to ${s.saved.collection}`}</span>
          </button>
        )}
        {slots?.slot3 && slotButton({ slot: 3 }, slots.slot3, { fresh: true })}
        {slots?.slot4 && slotButton({ slot: 4 }, slots.slot4, { fresh: true })}
        {s.badges.map((b) =>
          b.kind === 'person' ? (
            // A known person with open commitments or a note: opens their Who card.
            <button key={b.personId} className="badge" title={`Who is ${b.label.split(' · ')[0]}`} onClick={() => run(id, { action: 'who' })}>
              <UserRound size={13} strokeWidth={1.75} aria-hidden />
              {badgeLabel(b)}
            </button>
          ) : (
            // Saved items related to this selection: opens the Recall cards.
            <button key="recall" className="badge" title="What you saved before that relates to this" onClick={() => run(id, { action: 'recall' })}>
              <History size={13} strokeWidth={1.75} aria-hidden />
              {badgeLabel(b)}
            </button>
          ),
        )}
      </div>

      {menuOpen && (
        <div className="menu" role="menu">
          {s.hasSelection && (
            <>
              <div className="menu-label">
                More actions {s.keyboard && s.mode === 'bar' && <kbd>Tab</kbd>}
              </div>
              {more.length > 0 ? (
                more.map((m) => (
                  <button
                    key={m.action}
                    role="menuitem"
                    className={`menu-item${m.available ? '' : ' later'}${isHighlighted({ action: m.action }) ? ' highlight' : ''}`}
                    title={titleFor(m)}
                    onClick={() => {
                      setMenuOpen(false);
                      run(id, { action: m.action });
                    }}
                  >
                    <ActionIcon action={m.action} />
                    <span>{m.label}</span>
                  </button>
                ))
              ) : (
                <div className="menu-empty">No other actions fit this selection.</div>
              )}
              <div className="menu-sep" />
            </>
          )}
          {s.siteKey && (
            <button
              role="menuitem"
              className="menu-item"
              title="Show the bar here only when you press the hotkey"
              onClick={() => void glossly.invoke('bar:dont-show-here', { sessionId: id })}
            >
              <EyeOff size={16} strokeWidth={1.75} aria-hidden />
              <span>Don't show here ({s.siteKey})</span>
            </button>
          )}
          <button role="menuitem" className="menu-item" onClick={() => void glossly.invoke('settings:open', {})}>
            <Settings size={16} strokeWidth={1.75} aria-hidden />
            <span>Settings</span>
          </button>
          <button role="menuitem" className="menu-item" onClick={() => void glossly.invoke('bar:close', { sessionId: id })}>
            <X size={16} strokeWidth={1.75} aria-hidden />
            <span>Close</span>
            {s.keyboard && <kbd>Esc</kbd>}
          </button>
        </div>
      )}

      {s.notice && (
        <div className="strip">
          <Info size={15} strokeWidth={1.75} aria-hidden />
          <span>{s.notice}</span>
        </div>
      )}
      {!s.hasSelection && !s.notice && s.panel !== 'search' && (
        <div className="strip">
          <Info size={15} strokeWidth={1.75} aria-hidden />
          <span>Nothing selected. Search what you saved, ask a question, or select text and press the hotkey again.</span>
        </div>
      )}

      {s.mode === 'panel' &&
        s.panel &&
        (s.panel === 'ask' ? (
          <AskPanel key="ask" s={s} />
        ) : s.panel === 'save' ? (
          <SavePanel key="save" s={s} />
        ) : s.panel === 'who' ? (
          <WhoPanel key="who" s={s} />
        ) : s.panel === 'promises' ? (
          <PromisesPanel key="promises" s={s} />
        ) : s.panel === 'reply' ? (
          <ReplyPanel key="reply" s={s} />
        ) : s.panel === 'search' ? (
          <SearchPanel key="search" s={s} />
        ) : s.panel === 'recall' ? (
          <RecallPanel key="recall" s={s} />
        ) : s.panel === 'paste_list' || s.panel === 'paste_summary' ? (
          <PastePanel key={s.panel} s={s} kind={s.panel === 'paste_list' ? 'list' : 'summary'} />
        ) : (
          <LaterPanel key={s.panel} action={s.panel} sessionId={id} keyboard={s.keyboard} />
        ))}

      {s.debug && <Debug d={s.debug} slots={slots} />}
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<Overlay />);
