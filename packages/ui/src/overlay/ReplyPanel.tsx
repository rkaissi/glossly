import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Check, ClipboardCheck, Copy, CornerDownLeft, Info, Pencil, RotateCcw, UserRoundPlus } from 'lucide-react';
import type { AskErrorEvent, OverlayState, ReplyStart } from '@glossly/core/api';
import { glossly } from '../bridge';
import { appName } from '../dates';
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

function hasTextSelection(): boolean {
  const el = document.activeElement;
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) return el.selectionStart !== el.selectionEnd;
  return Boolean(window.getSelection()?.toString());
}

/**
 * Reply: three drafts labeled by intent. Tab cycles, Enter inserts the picked one into the app
 * the message came from (nothing is ever sent), Ctrl+C copies, and Edit changes it first.
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
  const current = useRef<string | null>(null);
  const waiting = useRef(false);
  const early = useRef(new Map<string, ReplyEvent[]>());
  const panel = useRef<HTMLDivElement>(null);
  const editor = useRef<HTMLTextAreaElement>(null);

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
    return () => {
      offs.forEach((off) => off());
      if (current.current) void glossly.invoke('reply:cancel', { requestId: current.current });
    };
  }, []);

  const run = async () => {
    if (current.current) void glossly.invoke('reply:cancel', { requestId: current.current });
    current.current = null;
    waiting.current = true;
    early.current.clear();
    setStream({ status: 'starting' });
    setEdits({});
    setEditing(false);
    setPick(0);
    setNote(null);
    const r = await glossly.invoke('reply:start', { sessionId: s.sessionId });
    waiting.current = false;
    current.current = r.requestId;
    setStart(r);
    const queued = early.current.get(r.requestId) ?? [];
    early.current.clear();
    if (queued.length) setStream((st) => queued.reduce(apply, st));
  };

  useEffect(() => {
    void run();
    // One run per panel; the session id never changes inside it.
  }, []);

  useEffect(() => {
    if (s.keyboard && !editing) panel.current?.focus();
  }, [s.keyboard, editing]);

  const drafts = parseDrafts('raw' in stream ? stream.raw : '');
  const done = stream.status === 'done';
  const sel = Math.min(pick, Math.max(drafts.length - 1, 0));
  const draft = drafts[sel];
  const text = edits[sel] ?? draft?.text ?? '';
  const edited = edits[sel] !== undefined && edits[sel] !== draft?.text;

  const insert = async () => {
    if (!done || !text.trim() || busy) return;
    setBusy(true);
    try {
      const r = await glossly.invoke('reply:insert', { sessionId: s.sessionId, text, edited, ...(personId && { personId }) });
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
    void glossly.invoke('reply:copied', { sessionId: s.sessionId });
    setNote('Copied.');
  };

  const addPerson = async () => {
    const name = start?.to.name;
    if (!name) return;
    const card = await glossly.invoke('people:create', { name, ...(name.includes('@') && { email: name }) }).catch(() => null);
    if (card) setPersonId(card.id);
  };

  const turnOffLocalOnly = async () => {
    const r = await glossly.invoke('settings:set', { key: 'localOnly', value: false });
    if (!r.error) await run();
  };

  const onKeyDown = (e: KeyboardEvent) => {
    const inEditor = e.target === editor.current;
    if (e.key === 'Tab' && !inEditor && drafts.length > 1) {
      e.preventDefault();
      const n = drafts.length;
      setPick((i) => (Math.min(i, n - 1) + (e.shiftKey ? n - 1 : 1)) % n);
      setNote(null);
    } else if (e.key === 'Enter' && (!inEditor || e.ctrlKey)) {
      e.preventDefault();
      void insert();
    } else if (e.key === 'c' && e.ctrlKey && !hasTextSelection()) {
      e.preventDefault();
      copy();
    } else if (e.key === 'Escape' && inEditor) {
      e.preventDefault();
      setEditing(false);
    }
  };

  const to = start?.to;
  const appLabel = s.siteKey ? (s.siteKey.endsWith('.exe') ? appName(s.siteKey) : s.siteKey.replace(/^[-|]\s*/, '')) : 'the app';
  const heading = to?.authorIsMe ? 'Follow up on your message' : to?.name ? `Reply to ${to.name}` : 'Reply';
  const known = Boolean(to?.personId || personId);

  return (
    <div className="panel reply" tabIndex={-1} ref={panel} onKeyDown={onKeyDown}>
      <div className="reply-head">
        <h2>{heading}</h2>
        {to?.name && !to.authorIsMe && !known && to.match === 'none' && (
          <button className="ghost" title="Add them to your people, so replies and promises are kept with them" onClick={() => void addPerson()}>
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
                  if (!picked) {
                    setPick(i);
                    setEditing(false);
                    setNote(null);
                  }
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
        </ul>
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
        {done && draft && (
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
        {s.keyboard && done && draft && (
          <span>
            <kbd>Tab</kbd> next · <kbd>{editing ? 'Ctrl+Enter' : 'Enter'}</kbd> insert · <kbd>Esc</kbd> {editing ? 'stop editing' : 'back'}
          </span>
        )}
      </div>
    </div>
  );
}
