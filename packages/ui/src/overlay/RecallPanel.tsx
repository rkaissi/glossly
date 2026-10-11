import { useEffect, useState } from 'react';
import { Check, Copy, MessageCircle, X } from 'lucide-react';
import type { OverlayState, RecallHit } from '@glossly/core/api';
import { glossly } from '../bridge';
import { SavedRow } from './saved';

/**
 * Behind the Recall badge (spec: Recall): what you saved before that relates to this selection,
 * with why it matched. No AI summary; "Ask about these" sends the cards to Ask.
 */
export function RecallPanel({ s }: { s: OverlayState }) {
  const [hits, setHits] = useState<RecallHit[] | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void glossly.invoke('recall:get', { sessionId: s.sessionId }).then((r) => live && setHits(r.hits));
    return () => {
      live = false;
    };
  }, [s.sessionId]);

  const dismiss = (itemId: string) => {
    setHits((h) => h?.filter((x) => x.itemId !== itemId) ?? null);
    void glossly.invoke('recall:dismiss', { sessionId: s.sessionId, itemId });
  };
  const copy = (itemId: string) => void glossly.invoke('items:copy', { itemId }).then(() => setCopied(itemId));

  return (
    <div className="panel recall">
      <h2>Saved before</h2>
      {!hits && <p className="muted">Looking…</p>}
      {hits?.length === 0 && <p className="muted">Nothing related is left.</p>}
      {hits && hits.length > 0 && (
        <ul className="saved-list search-body">
          {hits.map((h) => (
            <SavedRow
              key={h.itemId}
              hit={h}
              actions={
                <>
                  <button className="ghost icon-only" title="Copy" aria-label="Copy" onClick={() => copy(h.itemId)}>
                    {copied === h.itemId ? <Check size={14} strokeWidth={2} aria-hidden /> : <Copy size={14} strokeWidth={1.75} aria-hidden />}
                  </button>
                  <button className="ghost" title="Not related to this selection" onClick={() => dismiss(h.itemId)}>
                    <X size={14} strokeWidth={1.75} aria-hidden />
                    Not related
                  </button>
                </>
              }
            />
          ))}
        </ul>
      )}
      <div className="panel-foot">
        <span className="spacer" />
        {hits && hits.length > 0 && (
          <button onClick={() => void glossly.invoke('recall:ask', { sessionId: s.sessionId })}>
            <MessageCircle size={14} strokeWidth={1.75} aria-hidden />
            Ask about these
          </button>
        )}
        {s.keyboard && (
          <span>
            <kbd>Esc</kbd> back
          </span>
        )}
      </div>
    </div>
  );
}
