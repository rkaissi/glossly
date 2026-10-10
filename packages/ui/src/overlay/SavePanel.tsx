import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Check, Undo2 } from 'lucide-react';
import type { OverlayState, SaveDone } from '@glossly/core/api';
import { glossly } from '../bridge';

type Phase =
  | { kind: 'choose' }
  | { kind: 'saving' }
  | { kind: 'saved'; done: SaveDone; why: string }
  | { kind: 'undone'; collection: string; ok: boolean }
  | { kind: 'error'; message: string };

/**
 * Save: Enter saves to the predicted collection, Tab cycles collections, and the optional
 * "why" field is focused from the start. After saving, Undo stays available until undoUntil
 * and the why can still be edited (Enter updates it and closes).
 */
export function SavePanel({ s }: { s: OverlayState }) {
  const predicted = s.slots?.slot2.collection ?? 'Notes';
  const [collections, setCollections] = useState<string[]>([predicted]);
  const [index, setIndex] = useState(0);
  const [why, setWhy] = useState('');
  const [phase, setPhase] = useState<Phase>({ kind: 'choose' });
  const [left, setLeft] = useState(0);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void glossly.invoke('settings:get').then((v) => {
      const list = v.collections.includes(predicted) ? v.collections : [predicted, ...v.collections];
      setCollections(list);
      setIndex(Math.max(0, list.indexOf(predicted)));
    });
  }, [predicted]);

  useEffect(() => {
    if (s.keyboard) input.current?.focus();
  }, [s.keyboard]);

  const undoUntil = phase.kind === 'saved' ? phase.done.undoUntil : 0;
  useEffect(() => {
    if (!undoUntil) return;
    const tick = () => setLeft(Math.max(0, Math.ceil((undoUntil - Date.now()) / 1000)));
    tick();
    const t = setInterval(tick, 250);
    return () => clearInterval(t);
  }, [undoUntil]);

  const collection = collections[index] ?? predicted;

  const save = async () => {
    if (phase.kind !== 'choose' && phase.kind !== 'error') return;
    setPhase({ kind: 'saving' });
    try {
      const w = why.trim();
      const done = await glossly.invoke('save:save', { sessionId: s.sessionId, collection, ...(w && { why: w }) });
      setPhase({ kind: 'saved', done, why: w });
      input.current?.focus();
    } catch {
      setPhase({ kind: 'error', message: 'Could not save. Try again.' });
    }
  };

  const undo = async () => {
    if (phase.kind !== 'saved') return;
    const r = await glossly.invoke('save:undo', { itemId: phase.done.itemId });
    setPhase({ kind: 'undone', collection: phase.done.collection, ok: r.undone });
  };

  const finish = async () => {
    if (phase.kind === 'saved' && why.trim() !== phase.why) {
      await glossly.invoke('save:setWhy', { itemId: phase.done.itemId, why: why.trim() });
    }
    void glossly.invoke('bar:close', { sessionId: s.sessionId });
  };

  const onKeyDown = (e: KeyboardEvent) => {
    const choosing = phase.kind === 'choose' || phase.kind === 'error';
    if (e.key === 'Tab' && choosing && collections.length > 1) {
      e.preventDefault();
      const n = collections.length;
      setIndex((i) => (i + (e.shiftKey ? n - 1 : 1)) % n);
    } else if (e.key === 'Enter' && e.target === input.current) {
      e.preventDefault();
      if (choosing) void save();
      else if (phase.kind === 'saved') void finish();
    }
  };

  const saved = phase.kind === 'saved';
  return (
    <div className="panel" onKeyDown={onKeyDown}>
      {saved ? (
        <h2 className="saved-line">
          <Check size={17} strokeWidth={2} aria-hidden />
          <span>
            Saved to {phase.done.collection}
            <span className="muted"> · {s.wordCount} words</span>
          </span>
        </h2>
      ) : phase.kind === 'undone' ? (
        <h2>{phase.ok ? `Removed from ${phase.collection}.` : 'Too late to undo; the item is kept.'}</h2>
      ) : (
        <div className="chips" role="radiogroup" aria-label="Collection">
          {collections.map((c, i) => (
            <button key={c} role="radio" aria-checked={i === index} className={`chip${i === index ? ' selected' : ''}`} onMouseDown={(e) => e.preventDefault()}
              onClick={() => setIndex(i)}
              tabIndex={-1}
            >
              {c}
            </button>
          ))}
        </div>
      )}

      {phase.kind !== 'undone' && (
        <div className="panel-input">
          <input
            ref={input}
            value={why}
            maxLength={500}
            placeholder="Why are you saving this? (optional)"
            spellCheck={false}
            onChange={(e) => setWhy(e.target.value)}
          />
          {saved ? (
            left > 0 && (
              <button onClick={() => void undo()}>
                <Undo2 size={15} strokeWidth={1.75} aria-hidden />
                Undo ({left}s)
              </button>
            )
          ) : (
            <button className="primary" onClick={() => void save()} disabled={phase.kind === 'saving'}>
              {phase.kind === 'saving' ? 'Saving…' : `Save to ${collection}`}
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
              <kbd>Enter</kbd> save · <kbd>Tab</kbd> next collection · <kbd>Esc</kbd> back
            </span>
          )}
        </div>
      )}
    </div>
  );
}
