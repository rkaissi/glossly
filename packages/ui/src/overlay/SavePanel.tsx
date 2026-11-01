import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { CalendarDays, Check, CircleCheck, Globe, PencilLine, Plus, Undo2, UserRound, X } from 'lucide-react';
import type { ItemLinkKind, OverlayState, SaveDone, SaveLinkView, SaveOpen } from '@glossly/core/api';
import { glossly } from '../bridge';

type Phase = { kind: 'choose' } | { kind: 'saving' } | { kind: 'saved'; done: SaveDone; why: string } | { kind: 'undone'; ok: boolean } | { kind: 'error'; message: string };

/** What an item is called (decision 84); the same words as core's ITEM_KIND_LABEL. */
const KIND_LABEL: Record<SaveDone['kind'], string> = { selection: 'Snippet', link: 'Link', chart: 'Chart', note: 'Memory' };
const LINK_ICON: Record<ItemLinkKind, typeof UserRound> = { person: UserRound, task: CircleCheck, event: CalendarDays };
const linkKey = (l: SaveLinkView) => `${l.kind}:${l.id}`;
const hostOf = (url: string | null) => {
  if (!url) return null;
  try {
    return /^https?:/.test(url) ? new URL(url).hostname.replace(/^www\./, '') : null;
  } catch {
    return null;
  }
};

/**
 * Save (decision 84): no collection to choose, so Enter saves. The panel shows what the item will
 * be, the people, tasks, and events it links to (each removable before saving), and offers to add
 * a person or a task or event, which save first and then open that action. The note is a quiet
 * "Add a note" link (or N) that opens a one-line field; after saving it can still be edited.
 */
export function SavePanel({ s }: { s: OverlayState }) {
  const [open, setOpen] = useState<SaveOpen | null>(null);
  const [removed, setRemoved] = useState<Set<string>>(new Set());
  const [noteOpen, setNoteOpen] = useState(false);
  const [why, setWhy] = useState('');
  const [phase, setPhase] = useState<Phase>({ kind: 'choose' });
  const [left, setLeft] = useState(0);
  const panel = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let live = true;
    void glossly
      .invoke('save:open', { sessionId: s.sessionId })
      .then((o) => live && setOpen(o))
      .catch(() => live && setOpen({ kind: 'selection', links: [], addPerson: null, addTask: false }));
    return () => {
      live = false;
    };
  }, [s.sessionId]);

  useEffect(() => {
    if (!s.keyboard) return;
    if (noteOpen) input.current?.focus();
    else panel.current?.focus();
  }, [s.keyboard, noteOpen]);

  const undoUntil = phase.kind === 'saved' ? phase.done.undoUntil : 0;
  useEffect(() => {
    if (!undoUntil) return;
    const tick = () => setLeft(Math.max(0, Math.ceil((undoUntil - Date.now()) / 1000)));
    tick();
    const t = setInterval(tick, 250);
    return () => clearInterval(t);
  }, [undoUntil]);

  const links = (open?.links ?? []).filter((l) => !removed.has(linkKey(l)));
  const choosing = phase.kind === 'choose' || phase.kind === 'error';

  const save = async (): Promise<SaveDone | null> => {
    if (phase.kind === 'saved') return phase.done;
    if (!choosing) return null;
    setPhase({ kind: 'saving' });
    try {
      const w = why.trim();
      const unlinkedPeople = (open?.links ?? []).filter((l) => l.kind === 'person' && removed.has(linkKey(l))).map((l) => l.id);
      const done = await glossly.invoke('save:save', {
        sessionId: s.sessionId,
        ...(w && { why: w }),
        links: links.map((l) => ({ kind: l.kind, target_id: l.id })),
        ...(unlinkedPeople.length && { unlinkedPeople }),
      });
      setPhase({ kind: 'saved', done, why: w });
      return done;
    } catch {
      setPhase({ kind: 'error', message: 'Could not save. Try again.' });
      return null;
    }
  };

  const undo = async () => {
    if (phase.kind !== 'saved') return;
    const r = await glossly.invoke('save:undo', { itemId: phase.done.itemId });
    setPhase({ kind: 'undone', ok: r.undone });
  };

  const finish = async () => {
    if (phase.kind === 'saved' && why.trim() !== phase.why) {
      await glossly.invoke('save:setWhy', { itemId: phase.done.itemId, why: why.trim() });
    }
    void glossly.invoke('bar:close', { sessionId: s.sessionId });
  };

  /** "+ Add …": saves first, so what gets added links back to the item, then opens that action. */
  const offer = async (action: 'who' | 'promises') => {
    const done = await save();
    if (!done) return;
    if (phase.kind === 'saved' && why.trim() !== phase.why) await glossly.invoke('save:setWhy', { itemId: done.itemId, why: why.trim() });
    void glossly.invoke('bar:run', { sessionId: s.sessionId, action });
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && (e.target === input.current || e.target === panel.current)) {
      e.preventDefault();
      if (choosing) void save();
      else if (phase.kind === 'saved') void finish();
    } else if ((e.key === 'n' || e.key === 'N') && e.target === panel.current && !noteOpen && phase.kind !== 'undone') {
      e.preventDefault();
      setNoteOpen(true);
    }
  };

  const saved = phase.kind === 'saved';
  const kind = KIND_LABEL[saved ? phase.done.kind : (open?.kind ?? 'selection')];
  const offers = choosing || saved ? { person: open?.addPerson ?? null, task: open?.addTask ?? false } : { person: null, task: false };
  return (
    <div className="panel save-panel" onKeyDown={onKeyDown} ref={panel} tabIndex={-1}>
      {saved ? (
        <h2 className="saved-line">
          <Check size={16} strokeWidth={2} aria-hidden />
          <span>
            Saved as a {kind.toLowerCase()}
            <span className="muted"> · just now</span>
          </span>
        </h2>
      ) : phase.kind === 'undone' ? (
        <h2>{phase.ok ? 'Removed.' : 'Too late to undo; the item is kept.'}</h2>
      ) : (
        <h2>
          Save <span className="muted">· {kind}</span>
        </h2>
      )}

      {phase.kind !== 'undone' && open?.page && (open.page.title || open.page.url) && (
        <span className="from-page" title={open.page.url ?? undefined}>
          <Globe size={12} strokeWidth={1.75} aria-hidden />
          <span className="from-page-title">{open.page.title ?? hostOf(open.page.url)}</span>
          {open.page.title && hostOf(open.page.url) && <span className="muted">{hostOf(open.page.url)}</span>}
        </span>
      )}

      {phase.kind !== 'undone' && links.length > 0 && (
        <div className="chips" aria-label="Links to">
          {links.map((l) => {
            const Icon = LINK_ICON[l.kind];
            return (
              <span key={linkKey(l)} className="link-chip" title={l.label}>
                <Icon size={13} strokeWidth={1.75} aria-hidden />
                <span className="link-chip-text">{l.label}</span>
                {choosing && (
                  <button
                    className="icon-btn xs"
                    title={`Don't link ${l.label}`}
                    aria-label={`Don't link ${l.label}`}
                    tabIndex={-1}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => setRemoved((r) => new Set(r).add(linkKey(l)))}
                  >
                    <X size={12} strokeWidth={2} aria-hidden />
                  </button>
                )}
              </span>
            );
          })}
        </div>
      )}

      {(offers.person || offers.task) && (
        <div className="chips">
          {offers.task && (
            <button className="chip offer" tabIndex={-1} onMouseDown={(e) => e.preventDefault()} onClick={() => void offer('promises')}>
              <Plus size={13} strokeWidth={2} aria-hidden />
              Add as task or event
            </button>
          )}
          {offers.person && (
            <button className="chip offer" tabIndex={-1} onMouseDown={(e) => e.preventDefault()} onClick={() => void offer('who')}>
              <Plus size={13} strokeWidth={2} aria-hidden />
              Add person: {offers.person}
            </button>
          )}
        </div>
      )}

      {phase.kind !== 'undone' && (
        <div className="panel-input">
          {noteOpen || why ? (
            <input
              ref={input}
              value={why}
              maxLength={500}
              placeholder="A note for later (optional)"
              spellCheck={false}
              onChange={(e) => setWhy(e.target.value)}
            />
          ) : (
            <button className="add-note" tabIndex={-1} onMouseDown={(e) => e.preventDefault()} onClick={() => setNoteOpen(true)}>
              <PencilLine size={13} strokeWidth={1.75} aria-hidden />
              Add a note
            </button>
          )}
          <span className="spacer" />
          {saved ? (
            left > 0 && (
              <button onClick={() => void undo()}>
                <Undo2 size={14} strokeWidth={1.75} aria-hidden />
                Undo ({left}s)
              </button>
            )
          ) : (
            <button className="primary" onClick={() => void save()} disabled={phase.kind === 'saving'}>
              {phase.kind === 'saving' ? 'Saving…' : 'Save'}
            </button>
          )}
        </div>
      )}

      {phase.kind === 'error' && <p className="error">{phase.message}</p>}

      {s.keyboard && (
        <div className="panel-foot">
          <span className="spacer" />
          {saved ? (
            <span>
              <kbd>Enter</kbd> done · <kbd>Esc</kbd> back
            </span>
          ) : phase.kind === 'undone' ? (
            <span>
              <kbd>Esc</kbd> back
            </span>
          ) : (
            <span>
              <kbd>Enter</kbd> save{!noteOpen && <> · <kbd>N</kbd> note</>} · <kbd>Esc</kbd> back
            </span>
          )}
        </div>
      )}
    </div>
  );
}
