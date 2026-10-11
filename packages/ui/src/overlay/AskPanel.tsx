import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { ArrowUp, Bookmark, Check, Copy, Undo2 } from 'lucide-react';
import type { AskErrorEvent, AskSaved, OverlayState } from '@glossly/core/api';
import { glossly } from '../bridge';
import { AnswerText } from './AnswerText';
import { useSecondsLeft } from './SavedToast';

type Answer =
  | { status: 'starting' }
  | { status: 'streaming'; text: string }
  | { status: 'done'; text: string; model: string }
  | { status: 'error'; text: string; code: AskErrorEvent['code']; message: string };

type AskEvent = { kind: 'chunk'; text: string } | { kind: 'done'; model: string } | { kind: 'error'; code: AskErrorEvent['code']; message: string };

function apply(a: Answer | null, ev: AskEvent): Answer {
  const text = a && 'text' in a ? a.text : '';
  if (ev.kind === 'chunk') return { status: 'streaming', text: text + ev.text };
  if (ev.kind === 'done') return { status: 'done', text, model: ev.model };
  return { status: 'error', text, code: ev.code, message: ev.message };
}

/** True when the user has selected text in the panel; Ctrl+C then copies that instead of the answer. */
function hasTextSelection(): boolean {
  const el = document.activeElement;
  if (el instanceof HTMLInputElement) return el.selectionStart !== el.selectionEnd;
  return Boolean(window.getSelection()?.toString());
}

/** Ask: a question box (Enter with nothing typed uses the default question) and a streamed answer. */
export function AskPanel({ s }: { s: OverlayState }) {
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [copied, setCopied] = useState(false);
  /** A note Ask saved because the question asked it to remember something. */
  const [saved, setSaved] = useState<(AskSaved & { undone?: boolean }) | null>(null);
  const undoLeft = useSecondsLeft(saved && !saved.undone ? saved.undoUntil : null);
  const input = useRef<HTMLInputElement>(null);
  /** The live request id; null while ask:start is in flight. */
  const current = useRef<string | null>(null);
  const waiting = useRef(false);
  /** Events that arrived before ask:start returned the id. */
  const early = useRef(new Map<string, AskEvent[]>());

  useEffect(() => {
    if (s.keyboard) input.current?.focus();
  }, [s.keyboard]);

  useEffect(() => {
    const route = (requestId: string, ev: AskEvent) => {
      if (requestId === current.current) setAnswer((a) => apply(a, ev));
      else if (waiting.current) early.current.set(requestId, [...(early.current.get(requestId) ?? []), ev]);
    };
    const offs = [
      glossly.on('ask:chunk', (p) => route(p.requestId, { kind: 'chunk', text: p.text })),
      glossly.on('ask:done', (p) => route(p.requestId, { kind: 'done', model: p.model })),
      glossly.on('ask:error', (p) => route(p.requestId, { kind: 'error', code: p.code, message: p.message })),
      // Saving happens once per request, so it is matched on the id when it arrives or right after ask:start returns.
      glossly.on('ask:saved', (p) => {
        if (p.requestId === current.current || waiting.current) setSaved(p);
      }),
    ];
    return () => {
      offs.forEach((off) => off());
      if (current.current) void glossly.invoke('ask:cancel', { requestId: current.current });
    };
  }, []);

  const submit = async () => {
    if (!s.hasSelection && !question.trim()) return;
    if (current.current) void glossly.invoke('ask:cancel', { requestId: current.current });
    current.current = null;
    waiting.current = true;
    early.current.clear();
    setAnswer({ status: 'starting' });
    setCopied(false);
    setSaved(null);
    const { requestId } = await glossly.invoke('ask:start', { sessionId: s.sessionId, question });
    waiting.current = false;
    current.current = requestId;
    const queued = early.current.get(requestId) ?? [];
    early.current.clear();
    if (queued.length) setAnswer((a) => queued.reduce<Answer | null>(apply, a) as Answer);
  };

  const switchToAllModels = async () => {
    const r = await glossly.invoke('settings:set', { key: 'privacy', value: 'all' });
    if (!r.error) await submit();
  };

  const text = answer && 'text' in answer ? answer.text : '';

  const copy = () => {
    if (!text) return;
    void glossly.invoke('clipboard:write', { text });
    setCopied(true);
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && e.target === input.current) {
      e.preventDefault();
      void submit();
    } else if (e.key === 'c' && e.ctrlKey && !hasTextSelection()) {
      e.preventDefault();
      copy();
    }
  };

  const busy = answer?.status === 'starting' || answer?.status === 'streaming';
  const placeholder = s.hasSelection ? `Ask about ${s.wordCount} words, or press Enter to explain` : 'Nothing selected. Type a question';

  return (
    <div className="panel" onKeyDown={onKeyDown}>
      <div className="composer">
        <input ref={input} value={question} placeholder={placeholder} spellCheck={false} onChange={(e) => setQuestion(e.target.value)} />
        <button
          className="primary send"
          title={busy ? 'Asking…' : 'Ask'}
          aria-label="Ask"
          onClick={() => void submit()}
          disabled={!s.hasSelection && !question.trim()}
        >
          <ArrowUp size={16} strokeWidth={2} aria-hidden />
        </button>
      </div>

      {answer && (
        <div className={`answer${busy ? ' cursor' : ''}`}>
          {answer.status === 'starting' && <p className="thinking">Thinking…</p>}
          {text && <AnswerText text={text} />}
          {answer.status === 'error' && (
            <div className="answer-error">
              <span className="error">{answer.message}</span>
              {answer.code === 'no_model' && (
                <button onClick={() => void glossly.invoke('settings:open', { tab: 'models' })}>Add a key</button>
              )}
              {answer.code === 'local_only' && (
                <>
                  <button onClick={() => void switchToAllModels()}>Use all models and ask</button>
                  <button onClick={() => void glossly.invoke('settings:open', { tab: 'models' })}>Set up a local model</button>
                </>
              )}
            </div>
          )}
        </div>
      )}

      {saved && (
        <div className="inline-note">
          <Bookmark size={14} strokeWidth={1.75} aria-hidden />
          <span>{saved.undone ? `Removed from ${saved.collection}.` : `Saved to ${saved.collection}.`}</span>
          {!saved.undone && undoLeft > 0 && (
            <button
              className="ghost"
              onClick={() =>
                void glossly.invoke('save:undo', { itemId: saved.itemId }).then((r) => r.undone && setSaved({ ...saved, undone: true }))
              }
            >
              <Undo2 size={14} strokeWidth={1.75} aria-hidden />
              Undo ({undoLeft}s)
            </button>
          )}
        </div>
      )}

      <div className="panel-foot">
        {answer?.status === 'done' && <span>{answer.model}</span>}
        <span className="spacer" />
        {text && !busy && (
          <button className="ghost" onClick={copy}>
            {copied ? <Check size={14} strokeWidth={2} aria-hidden /> : <Copy size={14} strokeWidth={1.75} aria-hidden />}
            {copied ? 'Copied' : 'Copy'}
          </button>
        )}
        {s.keyboard && (
          <span>
            <kbd>Enter</kbd> ask · <kbd>Ctrl+C</kbd> copy · <kbd>Esc</kbd> back
          </span>
        )}
      </div>
    </div>
  );
}
