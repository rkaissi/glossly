import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Check, Copy, Search as SearchIcon, UserRound } from 'lucide-react';
import type { OverlayState, SearchResults } from '@glossly/core/api';
import { glossly } from '../bridge';
import { formatDue } from '../dates';
import { SavedRow } from './saved';

const DEBOUNCE_MS = 120;

/**
 * The search box (hotkey with nothing selected): saved items by their words and by meaning,
 * people, and open commitments. Local only; nothing is sent to a model.
 */
export function SearchPanel({ s }: { s: OverlayState }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResults | null>(null);
  const [hl, setHl] = useState(0);
  const [copied, setCopied] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (s.keyboard) input.current?.focus();
  }, [s.keyboard]);

  useEffect(() => {
    let live = true;
    const t = setTimeout(
      () =>
        void glossly
          .invoke('search:query', { sessionId: s.sessionId, query })
          .then((r) => {
            if (!live) return;
            setResults(r);
            setHl(0);
          })
          .catch(() => live && setResults({ query, items: [], people: [], commitments: [], semantic: false })),
      query ? DEBOUNCE_MS : 0,
    );
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [query, s.sessionId]);

  const items = results?.items ?? [];
  const copy = (itemId: string) => {
    void glossly.invoke('items:copy', { itemId }).then(() => setCopied(itemId));
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown' && items.length) {
      e.preventDefault();
      setHl((i) => (i + 1) % items.length);
    } else if (e.key === 'ArrowUp' && items.length) {
      e.preventDefault();
      setHl((i) => (i - 1 + items.length) % items.length);
    } else if ((e.key === 'Enter' || (e.key === 'c' && e.ctrlKey && !window.getSelection()?.toString())) && items[hl]) {
      e.preventDefault();
      copy(items[hl].itemId);
    }
  };

  const empty = results && items.length === 0 && results.people.length === 0 && results.commitments.length === 0;
  return (
    <div className="panel search" onKeyDown={onKeyDown}>
      <div className="composer">
        <SearchIcon size={15} strokeWidth={1.75} aria-hidden className="muted" />
        <input
          ref={input}
          value={query}
          placeholder="Search what you saved, people, and promises"
          spellCheck={false}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      <div className="search-body">
        {results && !results.semantic && results.query && <p className="muted small-text">Matching exact words only until the local model is ready.</p>}
        {empty && <p className="muted">{results.query ? 'Nothing you saved matches.' : 'Nothing saved yet. Select text and press Save to keep it.'}</p>}

        {items.length > 0 && (
          <section>
            <h3 className="section-label">{results?.query ? 'Saved' : 'Recently saved'}</h3>
            <ul className="saved-list">
              {items.map((h, i) => (
                <SavedRow
                  key={h.itemId}
                  hit={h}
                  highlight={i === hl}
                  onClick={() => {
                    setHl(i);
                    copy(h.itemId);
                  }}
                  actions={
                    copied === h.itemId ? (
                      <span className="copied">
                        <Check size={13} strokeWidth={2} aria-hidden /> Copied
                      </span>
                    ) : (
                      <Copy size={13} strokeWidth={1.75} aria-label="Copy" />
                    )
                  }
                />
              ))}
            </ul>
          </section>
        )}

        {(results?.people.length ?? 0) > 0 && (
          <section>
            <h3 className="section-label">People</h3>
            <ul className="saved-list">
              {results!.people.map((p) => (
                <li key={p.id} className="saved-row clickable" onClick={() => void glossly.invoke('settings:open', { tab: 'people', personId: p.id })}>
                  <div className="saved-text person-line">
                    <UserRound size={14} strokeWidth={1.75} aria-hidden />
                    <span>{p.name}</span>
                    {p.open > 0 && <span className="muted"> · {p.open} open</span>}
                  </div>
                  {p.note && <div className="saved-why muted">{p.note}</div>}
                </li>
              ))}
            </ul>
          </section>
        )}

        {(results?.commitments.length ?? 0) > 0 && (
          <section>
            <h3 className="section-label">Open promises</h3>
            <ul className="saved-list">
              {results!.commitments.map((c) => {
                const due = formatDue(c.due_at);
                const who = c.owner === 'me' ? `You owe${c.person_name ? ` ${c.person_name}` : ''}` : `${c.person_name ?? 'They'} owe${c.person_name ? 's' : ''} you`;
                return (
                  <li key={c.id} className="saved-row clickable" onClick={() => void glossly.invoke('settings:open', { tab: 'people', ...(c.person_id && { personId: c.person_id }) })}>
                    <div className="saved-text">{c.text}</div>
                    <div className="saved-meta">
                      <span className="muted">{who}</span>
                      <span className={due.overdue ? 'error' : 'muted'}>{due.label}</span>
                    </div>
                  </li>
                );
              })}
            </ul>
          </section>
        )}
      </div>

      {s.keyboard && (
        <div className="panel-foot">
          <span className="spacer" />
          <span>
            <kbd>↑</kbd>
            <kbd>↓</kbd> move · <kbd>Enter</kbd> copy · <kbd>Esc</kbd> back
          </span>
        </div>
      )}
    </div>
  );
}
