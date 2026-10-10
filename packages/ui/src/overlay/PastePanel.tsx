import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { ClipboardCheck, Copy, CornerDownLeft, RotateCcw } from 'lucide-react';
import type { OverlayState, PasteCompose, PasteKind } from '@glossly/core/api';
import { glossly } from '../bridge';
import { ActionIcon } from '../icons';

/**
 * Paste for the bar with nothing selected: the recent snippets as a list, or a short summary.
 * The text is shown and editable first; Enter pastes it into the app (or copies it when the
 * focused control doesn't take text).
 */
export function PastePanel({ s, kind }: { s: OverlayState; kind: PasteKind }) {
  const [composed, setComposed] = useState<PasteCompose | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
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

  const insert = async () => {
    if (!ready || busy || !composed?.ok) return;
    setBusy(true);
    try {
      const r = await glossly.invoke('paste:insert', { sessionId: s.sessionId, kind, text, edited: text !== composed.text });
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

  const turnOffLocalOnly = async () => {
    const r = await glossly.invoke('settings:set', { key: 'localOnly', value: false });
    if (!r.error) await compose();
  };

  const onKeyDown = (e: KeyboardEvent) => {
    // Enter pastes; Shift+Enter adds a line while editing.
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void insert();
    }
  };

  const title = kind === 'list' ? 'Your recent snippets' : 'A summary of your recent snippets';
  return (
    <div className="panel paste" onKeyDown={onKeyDown}>
      <h2 className="saved-line">
        <ActionIcon action={kind === 'list' ? 'paste_list' : 'paste_summary'} size={17} />
        <span>
          {title}
          {composed?.ok && <span className="muted"> · {composed.count}</span>}
        </span>
      </h2>

      {!composed && <p className="muted">{kind === 'list' ? 'Gathering…' : 'Summarizing…'}</p>}
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
          {composed.code === 'no_model' && <button onClick={() => void glossly.invoke('settings:open', { tab: 'keys' })}>Add a key</button>}
          {composed.code === 'local_only' && <button onClick={() => void turnOffLocalOnly()}>Turn off Local only and summarize</button>}
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
