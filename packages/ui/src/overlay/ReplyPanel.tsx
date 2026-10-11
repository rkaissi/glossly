import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Check, ClipboardCheck, Copy, CornerDownLeft, Info, PenLine, Pencil, RotateCcw, UserRoundPlus } from 'lucide-react';
import type { AskErrorEvent, OverlayState, ReplyRedo, ReplyRedoAsk, ReplyStart } from '@glossly/core/api';
import { glossly } from '../bridge';
import { siteLabel } from '../dates';
import { CreatePerson } from '../people/PersonForm';
import { draftFrom } from '../people/draft';
import { parseDrafts } from './drafts';

type Stream =
  | { status: 'starting' }
  | { status: 'streaming'; raw: string }
  | { status: 'done'; raw: string; model: string }
  | { status: 'error'; raw: string; code: AskErrorEvent['code']; message: string };

type ReplyEvent = { kind: 'chunk'; text: string } | { kind: 'done'; model: string } | { kind: 'error'; code: AskErrorEvent['code']; message: string };

function apply(st: Stream, ev: ReplyEvent): Stream {
  const raw = 'raw' in st ? st.raw : '';
  if (ev.kind === 'chunk') return { status: 'streaming', raw: raw + ev.text };
  if (ev.kind === 'done') return { status: 'done', raw, model: ev.model };
  return { status: 'error', raw, code: ev.code, message: ev.message };
}

/** What "None of these" can ask for. A Record, so an ask added in core fails typecheck here until it has a label. */
const REDO_LABELS: Record<ReplyRedoAsk, string> = {
  shorter: 'Shorter',
  longer: 'Longer',
  casual: 'More casual',
  formal: 'More formal',
  different: 'Different answers',
};
const REDO_OPTIONS = Object.entries(REDO_LABELS) as [ReplyRedoAsk, string][];
/** `chosen` for a reply the user wrote themselves (core's WROTE_OWN). */
const WROTE_OWN = -1;

function hasTextSelection(): boolean {
  const el = document.activeElement;
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) return el.selectionStart !== el.selectionEnd;
  return Boolean(window.getSelection()?.toString());
}

/**
 * Reply: three drafts labeled by intent. Tab cycles, Enter inserts the picked one into the app
 * the message came from (nothing is ever sent), Ctrl+C copies, and Edit changes it first.
 * After the drafts, "Write my own" is a fourth choice with an empty box, and "None of these"
 * (N) asks for three new drafts: shorter, more casual, different answers, or in the user's words.
 */
export function ReplyPanel({ s }: { s: OverlayState }) {
  const [stream, setStream] = useState<Stream>({ status: 'starting' });
  const [start, setStart] = useState<ReplyStart | null>(null);
  const [pick, setPick] = useState(0);
  const [edits, setEdits] = useState<Record<number, string>>({});
  const [editing, setEditing] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [personId, setPersonId] = useState<string | undefined>(undefined);
  const [own, setOwn] = useState('');
  // "Add to people" opens the same form as Who is this, prefilled; work chat suggests a colleague.
  const [adding, setAdding] = useState(false);
  const [redoOpen, setRedoOpen] = useState(false);
  const [asks, setAsks] = useState<ReplyRedoAsk[]>([]);
  const [redoNote, setRedoNote] = useState('');
  const current = useRef<string | null>(null);
  const waiting = useRef(false);
  const early = useRef(new Map<string, ReplyEvent[]>());
  const panel = useRef<HTMLDivElement>(null);
  const editor = useRef<HTMLTextAreaElement>(null);
  const ownEditor = useRef<HTMLTextAreaElement>(null);
  const redoInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const route = (requestId: string, ev: ReplyEvent) => {
      if (requestId === current.current) setStream((st) => apply(st, ev));
      else if (waiting.current) early.current.set(requestId, [...(early.current.get(requestId) ?? []), ev]);
    };
    const offs = [
      glossly.on('reply:chunk', (p) => route(p.requestId, { kind: 'chunk', text: p.text })),
      glossly.on('reply:done', (p) => route(p.requestId, { kind: 'done', model: p.model })),
      glossly.on('reply:error', (p) => route(p.requestId, { kind: 'error', code: p.code, message: p.message })),
    ];
    // Closing the panel doesn't cancel the drafts: main finishes and keeps them for this highlight,
    // so switching to another action and back shows them without another call.
    return () => offs.forEach((off) => off());
  }, []);

  const run = async (redo?: ReplyRedo) => {
    if (current.current) void glossly.invoke('reply:cancel', { requestId: current.current });
    current.current = null;
    waiting.current = true;
    early.current.clear();
    setStream({ status: 'starting' });
    setEdits({});
    setEditing(false);
    setPick(0);
    setNote(null);
    setRedoOpen(false);
    setAsks([]);
    setRedoNote('');
    const r = await glossly.invoke('reply:start', { sessionId: s.sessionId, ...(redo && { redo }) });
    waiting.current = false;
    current.current = r.requestId;
    setStart(r);
    const queued = early.current.get(r.requestId) ?? [];
    early.current.clear();
    // Picking up a run still going: start from the text so far (it already holds anything queued).
    if (r.resumed !== undefined) setStream({ status: 'streaming', raw: r.resumed });
    else if (queued.length) setStream((st) => queued.reduce(apply, st));
  };

  useEffect(() => {
    void run();
    // One run per panel; the session id never changes inside it.
  }, []);

  const drafts = parseDrafts('raw' in stream ? stream.raw : '');
  const done = stream.status === 'done';
  // "Write my own" sits after the drafts once they are done.
  const choices = done && drafts.length > 0 ? drafts.length + 1 : drafts.length;
  const sel = Math.min(pick, Math.max(choices - 1, 0));
  const writingOwn = done && drafts.length > 0 && sel === drafts.length;
  const draft = writingOwn ? undefined : drafts[sel];
  const text = writingOwn ? own : (edits[sel] ?? draft?.text ?? '');
  const edited = writingOwn || (edits[sel] !== undefined && edits[sel] !== draft?.text);
  // Which draft this is, so Reply learns what gets picked (main keeps no text for a pick).
  const pickOf = () => ({ drafts: drafts.map((d) => ({ text: d.text, kind: d.kind, tone: d.tone })), chosen: writingOwn ? WROTE_OWN : sel });

  useEffect(() => {
    if (writingOwn) ownEditor.current?.focus();
    else if (s.keyboard && !editing && !redoOpen) panel.current?.focus();
  }, [s.keyboard, editing, writingOwn, redoOpen]);

  const choose = (i: number) => {
    setPick(i);
    setEditing(false);
    setNote(null);
  };

  const openRedo = () => {
    setRedoOpen(true);
    setTimeout(() => redoInput.current?.focus(), 0);
  };
  const toggleAsk = (a: ReplyRedoAsk) => setAsks((xs) => (xs.includes(a) ? xs.filter((x) => x !== a) : [...xs, a]));
  const redo = () => {
    if (!done) return;
    void run({ passedOn: drafts.map((d, i) => ({ intent: d.intent, text: edits[i] ?? d.text })), asks, note: redoNote.trim() || null });
  };

  const insert = async () => {
    if (!done || !text.trim() || busy) return;
    setBusy(true);
    try {
      const r = await glossly.invoke('reply:insert', { sessionId: s.sessionId, text, edited, pick: pickOf(), ...(personId && { personId }) });
      // On success the bar has closed; a copy keeps the panel open with how to paste.
      if (r.result === 'copied') {
        setNote(
          r.reason === 'not_editable'
            ? `Copied. Click the reply box in ${appLabel} and press Ctrl+V.`
            : r.reason === 'focus'
              ? "Copied. Couldn't switch back to the app; paste with Ctrl+V."
              : 'Copied. Paste with Ctrl+V.',
        );
      }
    } catch {
      setNote('Could not insert. Use Copy instead.');
    } finally {
      setBusy(false);
    }
  };

  const copy = () => {
    if (!text) return;
    void glossly.invoke('clipboard:write', { text });
    void glossly.invoke('reply:copied', { sessionId: s.sessionId, text, ...(done && { pick: pickOf() }), ...(personId && { personId }) });
    setNote('Copied.');
  };

  const turnOffLocalOnly = async () => {
    const r = await glossly.invoke('settings:set', { key: 'localOnly', value: false });
    if (!r.error) await run();
  };

  const onKeyDown = (e: KeyboardEvent) => {
    // The add-person form handles its own keys (Enter creates, Esc cancels); typing there is not a shortcut.
    if (e.target instanceof HTMLElement && e.target.closest('.create-person')) return;
    const inEditor = e.target === editor.current || e.target === ownEditor.current;
    if (redoOpen && e.target instanceof HTMLElement && e.target.closest('.redo')) {
      if (e.key === 'Enter') {
        e.preventDefault();
        redo();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        setRedoOpen(false);
      }
      return;
    }
    if (e.key === 'Tab' && choices > 1 && e.target !== editor.current) {
      e.preventDefault();
      setPick((i) => (Math.min(i, choices - 1) + (e.shiftKey ? choices - 1 : 1)) % choices);
      setEditing(false);
      setNote(null);
    } else if (e.key === 'Enter' && (!inEditor || e.ctrlKey)) {
      e.preventDefault();
      void insert();
    } else if (e.key === 'c' && e.ctrlKey && !hasTextSelection()) {
      e.preventDefault();
      copy();
    } else if (e.key === 'Escape' && inEditor) {
      e.preventDefault();
      if (writingOwn) choose(0);
      else setEditing(false);
    } else if ((e.key === 'n' || e.key === 'N') && !inEditor && !e.ctrlKey && !e.altKey && !e.metaKey && done && drafts.length > 0) {
      e.preventDefault();
      openRedo();
    }
  };

  const to = start?.to;
  const appLabel = s.siteKey ? siteLabel(s.siteKey) : 'the app';
  const heading = to?.authorIsMe ? 'Follow up on your message' : to?.name ? `Reply to ${to.name}` : 'Reply';
  const known = Boolean(to?.personId || personId);

  return (
    <div className="panel reply" tabIndex={-1} ref={panel} onKeyDown={onKeyDown}>
      <div className="reply-head">
        <h2>{heading}</h2>
        {to?.name && !to.authorIsMe && !known && to.match === 'none' && !adding && (
          <button
            className="ghost"
            title="Add them to your people, so replies and promises are kept with them"
            onClick={() => setAdding(true)}
          >
            <UserRoundPlus size={14} strokeWidth={1.75} aria-hidden />
            Add to people
          </button>
        )}
        {personId && (
          <span className="muted small-text">
            <Check size={13} strokeWidth={2} aria-hidden /> Added
          </span>
        )}
      </div>
      {adding && to?.name && !known && (
        <CreatePerson
          initial={draftFrom(
            { name: to.name.includes('@') || to.name.startsWith('@') ? '' : to.name, email: to.email, handle: to.handle },
            start?.channel === 'work_chat' ? 'colleague' : 'other',
          )}
          title={`Add ${to.name} to your people`}
          onCreated={(card) => {
            setPersonId(card.id);
            setAdding(false);
          }}
          onCancel={() => setAdding(false)}
        />
      )}
      {start && !start.identitySet && (
        <div className="inline-note">
          <Info size={14} strokeWidth={1.75} aria-hidden />
          <span>Add your name so drafts are written as you.</span>
          <button className="ghost" onClick={() => void glossly.invoke('settings:open', { tab: 'profile' })}>
            Add your name
          </button>
        </div>
      )}

      {stream.status === 'starting' && <p className="thinking">Writing drafts…</p>}
      {drafts.length > 0 && (
        <ul className="drafts" role="listbox" aria-label="Drafts">
          {drafts.map((d, i) => {
            const picked = i === sel;
            const growing = !done && i === drafts.length - 1;
            return (
              <li
                key={i}
                role="option"
                aria-selected={picked}
                className={`draft${picked ? ' picked' : ''}${growing ? ' cursor' : ''}`}
                onClick={() => {
                  if (!picked) choose(i);
                }}
              >
                <div className="draft-intent">
                  <span>{d.intent || `Draft ${i + 1}`}</span>
                  {edits[i] !== undefined && edits[i] !== d.text && <span className="muted">edited</span>}
                  <span className="spacer" />
                  {picked && done && !editing && (
                    <button
                      className="ghost icon-only"
                      title="Edit before inserting"
                      aria-label="Edit"
                      onClick={(e) => {
                        e.stopPropagation();
                        setEditing(true);
                        setTimeout(() => editor.current?.focus(), 0);
                      }}
                    >
                      <Pencil size={14} strokeWidth={1.75} aria-hidden />
                    </button>
                  )}
                </div>
                {picked && editing ? (
                  <textarea
                    ref={editor}
                    className="draft-editor"
                    value={text}
                    rows={Math.min(10, Math.max(3, text.split('\n').length + 1))}
                    onChange={(e) => setEdits((m) => ({ ...m, [i]: e.target.value }))}
                  />
                ) : (
                  <p className="draft-text">{edits[i] ?? d.text}</p>
                )}
              </li>
            );
          })}
          {done && (
            <li
              role="option"
              aria-selected={writingOwn}
              className={`draft own${writingOwn ? ' picked' : ''}`}
              onClick={() => {
                if (!writingOwn) choose(drafts.length);
              }}
            >
              <div className="draft-intent">
                <PenLine size={14} strokeWidth={1.75} aria-hidden />
                <span>Write my own</span>
              </div>
              {writingOwn && (
                <textarea
                  ref={ownEditor}
                  className="draft-editor"
                  value={own}
                  placeholder="Type your reply"
                  rows={Math.min(10, Math.max(3, own.split('\n').length + 1))}
                  onChange={(e) => setOwn(e.target.value)}
                />
              )}
            </li>
          )}
        </ul>
      )}
      {done && drafts.length > 0 && !redoOpen && (
        <div className="inline-note">
          <span className="muted">Your picks, edits, and own replies teach Reply how you write (Profile).</span>
          <span className="spacer" />
          <button className="ghost" onClick={openRedo} title="Write three new drafts">
            <RotateCcw size={14} strokeWidth={1.75} aria-hidden />
            None of these
          </button>
        </div>
      )}
      {done && drafts.length > 0 && redoOpen && (
        <div className="redo">
          <div className="chips" role="group" aria-label="What to change">
            {REDO_OPTIONS.map(([value, label]) => (
              <button
                key={value}
                role="checkbox"
                aria-checked={asks.includes(value)}
                className={`chip${asks.includes(value) ? ' selected' : ''}`}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => toggleAsk(value)}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="redo-row">
            <input
              ref={redoInput}
              value={redoNote}
              maxLength={500}
              placeholder="Or say what to change, like: say I'm out until Monday"
              onChange={(e) => setRedoNote(e.target.value)}
            />
            <button className="primary" onClick={redo}>
              <RotateCcw size={14} strokeWidth={1.75} aria-hidden />
              New drafts
            </button>
          </div>
        </div>
      )}

      {stream.status === 'error' && (
        <div className="answer-error">
          <span className="error">{stream.message}</span>
          {stream.code === 'no_model' && <button onClick={() => void glossly.invoke('settings:open', { tab: 'keys' })}>Add a key</button>}
          {stream.code === 'local_only' && <button onClick={() => void turnOffLocalOnly()}>Turn off Local only and write drafts</button>}
          {stream.code !== 'no_model' && stream.code !== 'local_only' && stream.code !== 'no_selection' && (
            <button onClick={() => void run()}>
              <RotateCcw size={14} strokeWidth={1.75} aria-hidden />
              Try again
            </button>
          )}
        </div>
      )}
      {note && (
        <div className="inline-note">
          <ClipboardCheck size={14} strokeWidth={1.75} aria-hidden />
          <span>{note}</span>
        </div>
      )}

      <div className="panel-foot">
        {stream.status === 'done' && <span>{stream.model}</span>}
        <span className="spacer" />
        {done && (draft || writingOwn) && (
          <>
            <button className="ghost" onClick={copy}>
              <Copy size={14} strokeWidth={1.75} aria-hidden />
              Copy
            </button>
            <button className="primary" disabled={busy || !text.trim()} onClick={() => void insert()}>
              <CornerDownLeft size={14} strokeWidth={1.75} aria-hidden />
              Insert
            </button>
          </>
        )}
        {s.keyboard && done && redoOpen && (
          <span>
            <kbd>Enter</kbd> new drafts · <kbd>Esc</kbd> close
          </span>
        )}
        {s.keyboard && done && !redoOpen && (draft || writingOwn) && (
          <span>
            <kbd>Tab</kbd> next · <kbd>{editing || writingOwn ? 'Ctrl+Enter' : 'Enter'}</kbd> insert ·{' '}
            {!editing && !writingOwn && (
              <>
                <kbd>N</kbd> none of these ·{' '}
              </>
            )}
            <kbd>Esc</kbd> {editing || writingOwn ? 'stop' : 'back'}
          </span>
        )}
      </div>
    </div>
  );
}
