import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Check, Copy, Search as SearchIcon, UserRound } from 'lucide-react';
import type { OverlayState, SearchResults } from '@glossly/core/api';
import { glossly } from '../bridge';
import { formatDue, formatEventTime } from '../dates';
import { SavedRow } from './saved';

const DEBOUNCE_MS = 120;

/**
 * The search box (hotkey with nothing selected): saved items by their words and by meaning,
 * people, and open commitments. Local only; nothing is sent to a model. Picking an item types
 * it into the field the hotkey was pressed in (`canInsert`), else copies it; the copy button
 * always copies.
 */
export function SearchPanel({ s }: { s: OverlayState }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResults | null>(null);
  const [hl, setHl] = useState(0);
  const [copied, setCopied] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
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
          .catch(() => live && setResults({ query, items: [], people: [], commitments: [], events: [], semantic: false })),
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
  // Inserting closes the bar. If the field turned out not to take text, it was copied instead.
  const pick = (itemId: string) => {
    if (!s.canInsert) return copy(itemId);
    void glossly
      .invoke('items:insert', { sessionId: s.sessionId, itemId })
      .then((r) => {
        if (r.result === 'copied') {
          setCopied(itemId);
          setNote('Copied. Click where it should go and press Ctrl+V.');
        }
      })
      .catch(() => setNote('Could not insert. Use the copy button instead.'));
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown' && items.length) {
      e.preventDefault();
      setHl((i) => (i + 1) % items.length);
    } else if (e.key === 'ArrowUp' && items.length) {
      e.preventDefault();
      setHl((i) => (i - 1 + items.length) % items.length);
    } else if (e.key === 'Enter' && items[hl]) {
      e.preventDefault();
      pick(items[hl].itemId);
    } else if (e.key === 'c' && e.ctrlKey && !window.getSelection()?.toString() && items[hl]) {
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
        {note && <p className="muted small-text">{note}</p>}
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
                    pick(h.itemId);
                  }}
                  actions={
                    copied === h.itemId ? (
                      <span className="copied">
                        <Check size={13} strokeWidth={2} aria-hidden /> Copied
                      </span>
                    ) : (
                      <button
                        className="ghost icon-only"
                        title="Copy"
                        aria-label="Copy"
                        onClick={(e) => {
                          // The row itself inserts; this button only copies.
                          e.stopPropagation();
                          setHl(i);
                          copy(h.itemId);
                        }}
                      >
                        <Copy size={13} strokeWidth={1.75} aria-hidden />
                      </button>
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

        {(results?.events.length ?? 0) > 0 && (
          <section>
            <h3 className="section-label">Upcoming events</h3>
            <ul className="saved-list">
              {results!.events.map((e) => (
                <li key={e.id} className="saved-row clickable" onClick={() => void glossly.invoke('settings:open', { tab: 'calendar' })}>
                  <div className="saved-text">{e.title}</div>
                  <div className="saved-meta">
                    <span className="muted">{formatEventTime(e)}</span>
                    {e.location && <span className="muted">{e.location}</span>}
                  </div>
                </li>
              ))}
            </ul>
          </section>
        )}

        {(results?.commitments.length ?? 0) > 0 && (
          <section>
            <h3 className="section-label">Open tasks</h3>
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
            <kbd>↓</kbd> move · <kbd>Enter</kbd> {s.canInsert ? 'insert' : 'copy'}
            {s.canInsert && (
              <>
                {' '}
                · <kbd>Ctrl+C</kbd> copy
              </>
            )}{' '}
            · <kbd>Esc</kbd> back
          </span>
        </div>
      )}
    </div>
  );
}
