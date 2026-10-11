import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { ClipboardCheck, Copy, CornerDownLeft, RotateCcw } from 'lucide-react';
import type { OverlayState, PasteCompose, PasteKind, PasteTarget } from '@glossly/core/api';
import { glossly } from '../bridge';
import { ActionIcon } from '../icons';

const PLACE: Record<PasteTarget, string> = { email: 'this email', chat: 'this chat', document: 'this document', code: 'this file', other: 'here' };

/** The panel's heading: what was picked, and for where. */
function heading(kind: PasteKind, c: PasteCompose | null): string {
  if (!c?.ok) return kind === 'list' ? 'Your snippets' : 'Written from your snippets';
  if (kind === 'summary') return `Written for ${PLACE[c.target]}`;
  return c.reason === 'related' ? `Snippets that fit ${PLACE[c.target]}` : 'Your recent snippets';
}

/**
 * Paste for the bar with nothing selected. Main picks the snippets that fit what is around the
 * cursor (else the newest) and shapes them for the spot: as a list (which can switch to the
 * snippets as saved), or written for it by the model. The text is shown and editable first;
 * Enter pastes it into the app (or copies it when the focused control doesn't take text).
 */
export function PastePanel({ s, kind }: { s: OverlayState; kind: PasteKind }) {
  const [composed, setComposed] = useState<PasteCompose | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [form, setForm] = useState<'list' | 'as_saved'>('list');
  const editor = useRef<HTMLTextAreaElement>(null);

  const compose = async () => {
    setComposed(null);
    setNote(null);
    const r = await glossly.invoke('paste:compose', { sessionId: s.sessionId, kind });
    setComposed(r);
    if (r.ok) setText(r.text);
  };

  useEffect(() => {
    void compose();
    // One compose per panel; the session id never changes inside it.
  }, []);

  useEffect(() => {
    if (s.keyboard && composed?.ok) editor.current?.focus();
  }, [s.keyboard, composed]);

  const ready = composed?.ok === true && text.trim().length > 0;
  const original = composed?.ok ? (form === 'as_saved' && composed.asSaved !== undefined ? composed.asSaved : composed.text) : '';
  // Switching the form replaces the box with that form; edits to the other one are dropped.
  const switchForm = (next: 'list' | 'as_saved') => {
    if (!composed?.ok || next === form) return;
    setForm(next);
    setText(next === 'as_saved' && composed.asSaved !== undefined ? composed.asSaved : composed.text);
  };

  const insert = async () => {
    if (!ready || busy || !composed?.ok) return;
    setBusy(true);
    try {
      const r = await glossly.invoke('paste:insert', { sessionId: s.sessionId, kind, text, edited: text !== original });
      // On success the bar has closed; a copy keeps the panel open with how to paste.
      if (r.result === 'copied') {
        setNote(r.reason === 'not_editable' ? 'Copied. Click where it should go and press Ctrl+V.' : 'Copied. Paste with Ctrl+V.');
      }
    } catch {
      setNote('Could not paste. Use Copy instead.');
    } finally {
      setBusy(false);
    }
  };

  const copy = () => {
    if (!text.trim()) return;
    void glossly.invoke('clipboard:write', { text });
    setNote('Copied.');
  };

  const switchToAllModels = async () => {
    const r = await glossly.invoke('settings:set', { key: 'privacy', value: 'all' });
    if (!r.error) await compose();
  };

  const onKeyDown = (e: KeyboardEvent) => {
    // Enter pastes; Shift+Enter adds a line while editing.
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void insert();
    }
  };

  const title = heading(kind, composed);
  const count = composed?.ok ? (kind === 'summary' && composed.count < composed.total ? `${composed.count} of ${composed.total}` : String(composed.count)) : null;
  return (
    <div className="panel paste" onKeyDown={onKeyDown}>
      <h2 className="saved-line">
        <ActionIcon action={kind === 'list' ? 'paste_list' : 'paste_summary'} size={17} />
        <span>
          {title}
          {count && <span className="muted"> · {count}</span>}
        </span>
      </h2>

      {composed?.ok && composed.asSaved !== undefined && (
        <div className="chips" role="radiogroup" aria-label="Format">
          {(
            [
              ['list', 'List'],
              ['as_saved', 'As saved'],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              role="radio"
              aria-checked={form === value}
              className={`chip${form === value ? ' selected' : ''}`}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => switchForm(value)}
            >
              {label}
            </button>
          ))}
        </div>
      )}
      {!composed && <p className="muted">{kind === 'list' ? 'Finding snippets…' : 'Writing…'}</p>}
      {composed?.ok && (
        <textarea
          ref={editor}
          className="draft-editor"
          value={text}
          spellCheck={false}
          rows={Math.min(12, Math.max(4, text.split('\n').length + 1))}
          onChange={(e) => setText(e.target.value)}
        />
      )}
      {composed && !composed.ok && (
        <div className="answer-error">
          <span className={composed.code === 'no_selection' ? 'muted' : 'error'}>{composed.message}</span>
          {composed.code === 'no_model' && <button onClick={() => void glossly.invoke('settings:open', { tab: 'models' })}>Add a key</button>}
          {composed.code === 'local_only' && (
            <>
              <button onClick={() => void switchToAllModels()}>Use all models and write it</button>
              <button onClick={() => void glossly.invoke('settings:open', { tab: 'models' })}>Set up a local model</button>
            </>
          )}
          {(composed.code === 'provider' || composed.code === 'timeout' || composed.code === 'invalid_output') && (
            <button onClick={() => void compose()}>
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
        <span className="spacer" />
        {composed?.ok && (
          <>
            <button className="ghost" onClick={copy}>
              <Copy size={14} strokeWidth={1.75} aria-hidden />
              Copy
            </button>
            <button className="primary" disabled={busy || !ready} onClick={() => void insert()}>
              <CornerDownLeft size={14} strokeWidth={1.75} aria-hidden />
              Paste
            </button>
          </>
        )}
        {s.keyboard && (
          <span>
            {composed?.ok && (
              <>
                <kbd>Enter</kbd> paste ·{' '}
              </>
            )}
            <kbd>Esc</kbd> back
          </span>
        )}
      </div>
    </div>
  );
}
