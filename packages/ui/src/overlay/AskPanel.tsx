import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { AskErrorEvent, OverlayState } from '@glossly/core/api';
import { glossly } from '../bridge';
import { AnswerText } from './AnswerText';

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
    const { requestId } = await glossly.invoke('ask:start', { sessionId: s.sessionId, question });
    waiting.current = false;
    current.current = requestId;
    const queued = early.current.get(requestId) ?? [];
    early.current.clear();
    if (queued.length) setAnswer((a) => queued.reduce<Answer | null>(apply, a) as Answer);
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
      <div className="panel-input">
        <input ref={input} value={question} placeholder={placeholder} spellCheck={false} onChange={(e) => setQuestion(e.target.value)} />
        <button className="primary" onClick={() => void submit()} disabled={!s.hasSelection && !question.trim()}>
          {busy ? 'Asking…' : 'Ask'}
        </button>
      </div>

      {answer && (
        <div className={`answer${busy ? ' cursor' : ''}`}>
          {answer.status === 'starting' && <p className="muted">Thinking…</p>}
          {text && <AnswerText text={text} />}
          {answer.status === 'error' && (
            <p className="error">
              {answer.message}{' '}
              {answer.code === 'no_model' && (
                <button onClick={() => void glossly.invoke('settings:open', { tab: 'keys' })}>Add a key</button>
              )}
            </p>
          )}
        </div>
      )}

      <div className="panel-foot">
        {answer?.status === 'done' && <span>{answer.model}</span>}
        <span className="spacer" />
        {text && !busy && <button onClick={copy}>{copied ? 'Copied' : 'Copy'}</button>}
        {s.keyboard && (
          <span>
            <kbd>Enter</kbd> ask · <kbd>Ctrl+C</kbd> copy · <kbd>Esc</kbd> back
          </span>
        )}
      </div>
    </div>
  );
}
