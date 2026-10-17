import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { ArrowUp, CalendarDays, CircleCheck, ClipboardCheck, ClipboardList, Copy, CornerDownLeft, FileText, RotateCcw } from 'lucide-react';
import type { AskErrorEvent, ContextUsed, OverlayState, PasteTarget, WriteAsk, WriteOpen, WriteStart, WriteStartArgs, WriteSuggestion } from '@glossly/core/api';
import { glossly } from '../bridge';
import { Checkbox, Segmented } from '../controls/Toggles';
import { ActionIcon } from '../icons';
import { UsedChip } from './UsedChip';
import { writtenText, wroteNothing } from './written';

type Stream =
  | { status: 'idle' }
  | { status: 'starting' }
  | { status: 'streaming'; raw: string }
  | { status: 'done'; raw: string }
  | { status: 'error'; raw: string; code: AskErrorEvent['code']; message: string };

type WriteEvent = { kind: 'chunk'; text: string } | { kind: 'done' } | { kind: 'error'; code: AskErrorEvent['code']; message: string };

function apply(st: Stream, ev: WriteEvent): Stream {
  const raw = 'raw' in st ? st.raw : '';
  if (ev.kind === 'chunk') return { status: 'streaming', raw: raw + ev.text };
  if (ev.kind === 'done') return { status: 'done', raw };
  return { status: 'error', raw, code: ev.code, message: ev.message };
}

const PLACE: Record<PasteTarget, string> = { email: 'this email', chat: 'this chat', document: 'this document', code: 'this file', other: 'here' };
/** A Record, so an ask added in core fails typecheck here until it has a label. */
const ASK_LABELS: Record<WriteAsk, string> = { shorter: 'Shorter', longer: 'Longer', casual: 'More casual', formal: 'More formal' };
const ASKS = Object.entries(ASK_LABELS) as [WriteAsk, string][];
const SUGGESTION_ICONS = { event: CalendarDays, task: CircleCheck, snippets: FileText } as const;
const MODES = [
  ['written', 'Written'],
  ['snippets', 'Snippets'],
] as const;
const FORMS = [
  ['list', 'List'],
  ['as_saved', 'As saved'],
] as const;
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const KIND_WORDS: Record<ContextUsed['kind'], string> = { note: 'notes', person: 'people', task: 'tasks', event: 'events' };
/** "notes and tasks", "notes, tasks, and events". */
const listKinds = (kinds: ContextUsed['kind'][]) => {
  const w = kinds.map((k) => KIND_WORDS[k]);
  return w.length < 3 ? w.join(' and ') : `${w.slice(0, -1).join(', ')}, and ${w[w.length - 1]}`;
};

/**
 * Write here (decision 81), for the bar with nothing selected. Written: the Chat model writes for
 * the spot from everything saved, continuing the text at the caret or writing what the user asks
 * (an empty field asks first, with suggestions); chips and a box change it, and the Used chip can
 * leave saved data out and rewrite. Snippets: the saved snippets that fit, ticked into a list or
 * as saved, with no model (and the only view without one). The text is editable; Enter pastes.
 */
export function WritePanel({ s }: { s: OverlayState }) {
  const [open, setOpen] = useState<WriteOpen | null>(null);
  const [openError, setOpenError] = useState<string | null>(null);
  const [mode, setMode] = useState<'written' | 'snippets'>('written');
  const [stream, setStream] = useState<Stream>({ status: 'idle' });
  const [start, setStart] = useState<WriteStart | null>(null);
  const [edit, setEdit] = useState<string | null>(null);
  const [box, setBox] = useState('');
  const [asked, setAsked] = useState<{ label: string; request: string; suggested: boolean } | null>(null);
  const [include, setInclude] = useState<ContextUsed['kind'][]>([]);
  const [off, setOff] = useState<Set<string>>(new Set());
  const [form, setForm] = useState<'list' | 'as_saved'>('list');
  const [snipEdit, setSnipEdit] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const current = useRef<string | null>(null);
  const waiting = useRef(false);
  const early = useRef(new Map<string, WriteEvent[]>());
  const editor = useRef<HTMLTextAreaElement>(null);
  const boxInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const route = (requestId: string, ev: WriteEvent) => {
      if (requestId === current.current) setStream((st) => apply(st, ev));
      else if (waiting.current) early.current.set(requestId, [...(early.current.get(requestId) ?? []), ev]);
    };
    const offs = [
      glossly.on('write:chunk', (p) => route(p.requestId, { kind: 'chunk', text: p.text })),
      glossly.on('write:done', (p) => route(p.requestId, { kind: 'done' })),
      glossly.on('write:error', (p) => route(p.requestId, { kind: 'error', code: p.code, message: p.message })),
    ];
    return () => {
      offs.forEach((o) => o());
      if (current.current) void glossly.invoke('write:cancel', { requestId: current.current });
    };
  }, []);

  const run = async (args: Omit<WriteStartArgs, 'sessionId'> = {}) => {
    if (current.current) void glossly.invoke('write:cancel', { requestId: current.current });
    current.current = null;
    waiting.current = true;
    early.current.clear();
    setStream({ status: 'starting' });
    setEdit(null);
    setNote(null);
    setMode('written');
    const r = await glossly.invoke('write:start', { sessionId: s.sessionId, ...args });
    waiting.current = false;
    current.current = r.requestId;
    setStart(r);
    const queued = early.current.get(r.requestId) ?? [];
    early.current.clear();
    if (queued.length) setStream((st) => queued.reduce(apply, st));
  };

  useEffect(() => {
    void glossly
      .invoke('write:open', { sessionId: s.sessionId })
      .then((o) => {
        setOpen(o);
        if (!o.model) setMode('snippets');
        else if (o.writing) void run();
      })
      .catch(() => setOpenError('This bar is gone. Press the hotkey again.'));
    // One open per panel; the session id never changes inside it.
  }, []);

  const raw = 'raw' in stream ? stream.raw : '';
  const written = writtenText(raw);
  const text = edit ?? written;
  const done = stream.status === 'done';
  const nothing = done && (wroteNothing(raw) || !written);
  const asking = mode === 'written' && open?.model === true && (stream.status === 'idle' || nothing);

  const snippets = open?.snippets ?? [];
  const kept = snippets.filter((x) => !off.has(x.id));
  const composed = form === 'list' ? kept.map((x) => x.line).join('\n') : kept.map((x) => x.full).join('\n\n');
  const snipText = snipEdit ?? composed;

  const shown = mode === 'written' ? text : snipText;
  const ready = shown.trim().length > 0 && (mode === 'snippets' || (done && !nothing));

  useEffect(() => {
    if (!s.keyboard) return;
    if (asking) boxInput.current?.focus();
    else if (ready) editor.current?.focus();
  }, [s.keyboard, asking, ready, mode]);

  // What every run carries: the request (a suggestion says so, so nothing is learned from it) and kinds put back.
  const base = (a = asked, inc = include): Omit<WriteStartArgs, 'sessionId'> => ({
    ...(a && { request: a.request, ...(a.suggested && { suggested: true }) }),
    ...(inc.length > 0 && { include: inc }),
  });
  const submitBox = () => {
    const words = box.trim();
    if (!words) return;
    setBox('');
    if (asking) {
      const a = { label: words, request: words, suggested: false };
      setAsked(a);
      void run(base(a));
    } else if (done && text.trim()) {
      void run({ ...base(), change: { previous: text, asks: [], note: words } });
    }
  };
  const pickSuggestion = (sg: WriteSuggestion) => {
    const a = { label: sg.label, request: sg.request, suggested: true };
    setAsked(a);
    void run(base(a));
  };
  const changeBy = (a: WriteAsk) => {
    if (!done || !text.trim()) return;
    void run({ ...base(), change: { previous: text, asks: [a] } });
  };
  const rewrite = () => void run(base());
  const putBack = () => {
    const inc = [...new Set([...include, ...(start?.leftOut ?? [])])];
    setInclude(inc);
    void run(base(asked, inc));
  };

  const insert = async () => {
    if (!ready || busy) return;
    setBusy(true);
    try {
      const original = mode === 'written' ? written : composed;
      const r = await glossly.invoke('write:insert', { sessionId: s.sessionId, mode, text: shown, edited: shown !== original, ...(mode === 'written' && { original: written }) });
      // On success the bar has closed; a copy keeps the panel open with how to paste.
      if (r.result === 'copied') setNote(r.reason === 'not_editable' ? 'Copied. Click where it should go and press Ctrl+V.' : 'Copied. Paste with Ctrl+V.');
    } catch {
      setNote('Could not paste. Use Copy instead.');
    } finally {
      setBusy(false);
    }
  };
  const copy = () => {
    if (!shown.trim()) return;
    void glossly.invoke('clipboard:write', { text: shown });
    setNote('Copied.');
  };
  const switchToAllModels = async () => {
    const r = await glossly.invoke('settings:set', { key: 'privacy', value: 'all' });
    if (!r.error) {
      const o = await glossly.invoke('write:open', { sessionId: s.sessionId });
      setOpen(o);
      if (o.model) {
        setMode('written');
        if (o.writing) void run();
      }
    }
  };
  const toggle = (id: string, on: boolean) => {
    setSnipEdit(null);
    setOff((o) => {
      const n = new Set(o);
      if (on) n.delete(id);
      else n.add(id);
      return n;
    });
  };

  const onKeyDown = (e: KeyboardEvent) => {
    // Enter pastes from the text box; Shift+Enter adds a line. The request box submits on its own.
    if (e.key === 'Enter' && !e.shiftKey && e.target === editor.current) {
      e.preventDefault();
      void insert();
    }
  };
  const onBoxKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      submitBox();
    }
  };

  const to = start?.to ?? open?.to ?? null;
  const place = open ? PLACE[open.target] : 'here';
  const switcher = open?.model && snippets.length > 0 && (
    <Segmented size="sm" label="View" value={mode} options={MODES} onChange={(m) => (m === 'written' && stream.status === 'idle' && open.writing ? void run() : setMode(m))} />
  );
  const composer = (placeholder: string, small: boolean) => (
    <div className={`composer${small ? ' small' : ''}`}>
      <input ref={boxInput} value={box} placeholder={placeholder} spellCheck={false} maxLength={500} onChange={(e) => setBox(e.target.value)} onKeyDown={onBoxKey} />
      <button className="primary send" aria-label={placeholder} title={placeholder} disabled={!box.trim()} onClick={submitBox}>
        <ArrowUp size={16} strokeWidth={2} aria-hidden />
      </button>
    </div>
  );

  if (openError) return <div className="panel write"><p className="error">{openError}</p></div>;
  if (!open) return <div className="panel write"><p className="muted">Looking around…</p></div>;

  return (
    <div className="panel write" onKeyDown={onKeyDown}>
      {mode === 'written' ? (
        <>
          <h2 className="saved-line">
            <ActionIcon action="write" size={16} />
            <span className="grow">
              {asked ? clip(asked.label, 48) : stream.status === 'idle' ? `Write in ${place}` : `Writing for ${place}`}
              {to && <span className="muted"> · to {to}</span>}
            </span>
            {switcher}
          </h2>

          {asking && (
            <>
              {nothing && <p className="muted">Nothing here to write from. Say what it should write.</p>}
              {composer('What should it write?', false)}
              {open.suggestions.length > 0 && (
                <div className="chips" aria-label="Suggestions">
                  {open.suggestions.map((sg) => {
                    const Icon = SUGGESTION_ICONS[sg.kind];
                    return (
                      <button key={sg.label} className="chip suggestion" onMouseDown={(e) => e.preventDefault()} onClick={() => pickSuggestion(sg)}>
                        <Icon size={14} strokeWidth={1.75} aria-hidden />
                        {sg.label}
                      </button>
                    );
                  })}
                </div>
              )}
            </>
          )}

          {stream.status === 'starting' && <p className="thinking">Writing…</p>}
          {(stream.status === 'streaming' || (done && !nothing) || (stream.status === 'error' && written)) && (
            <textarea
              ref={editor}
              className="draft-editor"
              value={text}
              readOnly={!done}
              spellCheck={false}
              rows={Math.min(12, Math.max(4, text.split('\n').length + 1))}
              onChange={(e) => setEdit(e.target.value)}
            />
          )}
          {done && !nothing && start && start.used.length > 0 && <UsedChip key={start.requestId} sessionId={s.sessionId} used={start.used} onRewrite={rewrite} />}
          {done && start && start.leftOut.length > 0 && (
            <div className="inline-note">
              <span className="muted">Left out your {listKinds(start.leftOut)} here, as you usually do.</span>
              <span className="spacer" />
              <button className="ghost" onClick={putBack}>
                Put back
              </button>
            </div>
          )}
          {done && !nothing && (
            <>
              <div className="chips" role="group" aria-label="Change it">
                {ASKS.map(([a, label]) => (
                  <button key={a} className="chip" onMouseDown={(e) => e.preventDefault()} onClick={() => changeBy(a)}>
                    {label}
                  </button>
                ))}
              </div>
              {composer('Tell it what to change…', true)}
            </>
          )}
          {stream.status === 'error' && (
            <div className="answer-error">
              <span className="error">{stream.message}</span>
              {stream.code === 'local_only' && <button onClick={() => void switchToAllModels()}>Use all models and write it</button>}
              {(stream.code === 'no_model' || stream.code === 'local_only') && <button onClick={() => void glossly.invoke('settings:open', { tab: 'models' })}>Set up a model</button>}
              {(stream.code === 'provider' || stream.code === 'timeout' || stream.code === 'invalid_output') && (
                <button onClick={rewrite}>
                  <RotateCcw size={14} strokeWidth={1.75} aria-hidden />
                  Try again
                </button>
              )}
              {snippets.length > 0 && <button onClick={() => setMode('snippets')}>Use my snippets</button>}
            </div>
          )}
        </>
      ) : (
        <>
          <h2 className="saved-line">
            <ClipboardList size={16} strokeWidth={1.75} aria-hidden />
            <span className="grow">
              {open.reason === 'related' ? `Snippets that fit ${place}` : 'Your recent snippets'}
              {snippets.length > 0 && <span className="muted"> · {kept.length === snippets.length ? snippets.length : `${kept.length} of ${snippets.length}`}</span>}
            </span>
            {switcher}
          </h2>
          {open.noModel && (
            <div className="inline-note">
              <span className="muted">{open.noModel.code === 'local_only' ? 'Local only has no local model to write with.' : 'Writing needs a model.'} Here are your snippets.</span>
              <span className="spacer" />
              {open.noModel.code === 'local_only' && <button className="ghost" onClick={() => void switchToAllModels()}>Use all models</button>}
              <button className="ghost" onClick={() => void glossly.invoke('settings:open', { tab: 'models' })}>
                Set up a model
              </button>
            </div>
          )}
          {snippets.length === 0 ? (
            <p className="muted">Nothing saved lately. Saved snippets show here.</p>
          ) : (
            <>
              <ul className="snippet-rows">
                {snippets.map((x) => (
                  <li key={x.id}>
                    <Checkbox checked={!off.has(x.id)} onChange={(on) => toggle(x.id, on)} label={`Include: ${clip(x.full, 60)}`} />
                    <span className="snippet-text">
                      <span className="snippet-line">{x.full}</span>
                      <span className="snippet-detail">{x.detail}</span>
                    </span>
                  </li>
                ))}
              </ul>
              <Segmented
                size="sm"
                label="Format"
                value={form}
                options={FORMS}
                onChange={(f) => {
                  setForm(f);
                  setSnipEdit(null);
                }}
              />
              {kept.length > 0 && (
                <textarea
                  ref={editor}
                  className="draft-editor"
                  value={snipText}
                  spellCheck={false}
                  rows={Math.min(10, Math.max(3, snipText.split('\n').length + 1))}
                  onChange={(e) => setSnipEdit(e.target.value)}
                />
              )}
            </>
          )}
        </>
      )}

      {note && (
        <div className="inline-note">
          <ClipboardCheck size={14} strokeWidth={1.75} aria-hidden />
          <span>{note}</span>
        </div>
      )}

      <div className="panel-foot">
        {s.keyboard && (
          <span>
            {ready ? (
              <>
                <kbd>Enter</kbd> paste ·{' '}
              </>
            ) : asking ? (
              <>
                <kbd>Enter</kbd> write ·{' '}
              </>
            ) : null}
            <kbd>Esc</kbd> back
          </span>
        )}
        <span className="spacer" />
        {mode === 'written' && asking && snippets.length > 0 && (
          <button className="ghost" onClick={() => setMode('snippets')}>
            <ClipboardList size={14} strokeWidth={1.75} aria-hidden />
            Just my snippets
          </button>
        )}
        {ready && (
          <>
            <button className="ghost" onClick={copy}>
              <Copy size={14} strokeWidth={1.75} aria-hidden />
              Copy
            </button>
            <button className="primary" disabled={busy} onClick={() => void insert()}>
              <CornerDownLeft size={14} strokeWidth={1.75} aria-hidden />
              Paste
            </button>
          </>
        )}
        {stream.status === 'streaming' && <span className="muted">Writing…</span>}
      </div>
    </div>
  );
}
