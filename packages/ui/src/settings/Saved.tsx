import { useEffect, useRef, useState } from 'react';
import { Check, Copy, Search, Trash2 } from 'lucide-react';
import type { LibraryItem, LibraryResult } from '@glossly/core/api';
import { glossly } from '../bridge';
import { Select } from '../controls/Select';
import { appName, formatDay } from '../dates';
import { useAction } from './useAction';

const PAGE = 30;
const KIND_LABEL: Record<LibraryItem['kind'], string | null> = { selection: null, note: 'Note', chart: 'Chart' };

/** One saved item: the text, where and when it was saved, and Copy, Move, and Delete (trash morphs in place). */
function SavedRow({ item, collections, onChanged }: { item: LibraryItem; collections: string[]; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const { busy, error, run } = useAction();
  const long = item.clipped || item.text.length > 280 || item.text.split('\n').length > 4;
  const kind = KIND_LABEL[item.kind];
  const copy = () =>
    void run(async () => {
      await glossly.invoke('items:copy', { itemId: item.itemId });
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  const move = (collection: string) =>
    void run(async () => {
      await glossly.invoke('items:move', { itemId: item.itemId, collection });
      onChanged();
    });
  const del = () =>
    void run(async () => {
      await glossly.invoke('items:delete', { itemId: item.itemId });
      onChanged();
    });
  return (
    <li className="saved-row">
      <p className={`saved-text${open ? '' : ' clip4'}`}>{item.text}</p>
      {long && (
        <button className="link small" onClick={() => setOpen((o) => !o)}>
          {open ? 'Show less' : item.clipped ? 'Show more (Copy copies all of it)' : 'Show more'}
        </button>
      )}
      {item.why && <p className="muted small">Why: {item.why}</p>}
      <div className="saved-meta">
        {kind && <span className="tag">{kind}</span>}
        <span className="muted small">
          {formatDay(item.created_at)}
          {item.source_app && ` · ${appName(item.source_app)}`}
          {item.reason === 'similar_topic' && ' · similar meaning'}
        </span>
        <span className="spacer" />
        <Select size="sm" label="Collection" value={item.collection} placeholder="No collection" disabled={busy} onChange={move} options={collections.map((c) => ({ value: c, label: c }))} />
        <button className="icon-btn sm" title="Copy" aria-label="Copy" disabled={busy} onClick={copy}>
          {copied ? <Check size={14} strokeWidth={1.75} aria-hidden /> : <Copy size={14} strokeWidth={1.75} aria-hidden />}
        </button>
        {/* Same morph as the event editor (decision 46): trash grows into Delete; blur backs out. */}
        <button
          type="button"
          className={`delete-btn${confirming ? ' armed' : ''}`}
          title={confirming ? 'Delete this saved item' : 'Delete'}
          aria-label={confirming ? 'Confirm: delete this saved item' : 'Delete'}
          disabled={busy}
          onClick={() => (confirming ? void del() : setConfirming(true))}
          onBlur={() => setConfirming(false)}
        >
          <Trash2 size={14} strokeWidth={1.75} aria-hidden />
          <span>Delete</span>
        </button>
      </div>
      {error && <p className="error small">{error}</p>}
    </li>
  );
}

/**
 * Settings > Saved: everything saved with Glossly, filtered by collection and searched by words,
 * then by meaning when the embedding model is ready. Nothing here calls a model provider.
 */
export function SavedTab() {
  const [query, setQuery] = useState('');
  const [collection, setCollection] = useState<string | null>(null);
  const [limit, setLimit] = useState(PAGE);
  const [result, setResult] = useState<LibraryResult | null>(null);
  const [tick, setTick] = useState(0);
  const seq = useRef(0);

  useEffect(() => {
    const n = ++seq.current;
    // A short pause while typing, none for a filter or a refresh.
    const t = setTimeout(
      () => void glossly.invoke('library:query', { query, collection, limit }).then((r) => n === seq.current && setResult(r)),
      query ? 150 : 0,
    );
    return () => clearTimeout(t);
  }, [query, collection, limit, tick]);

  // Items saved from the overlay while this tab is open show up when the window comes back.
  useEffect(() => {
    const refresh = () => setTick((x) => x + 1);
    window.addEventListener('focus', refresh);
    return () => window.removeEventListener('focus', refresh);
  }, []);

  const refresh = () => setTick((x) => x + 1);
  const names = result?.collections.map((c) => c.name) ?? [];
  const pick = (c: string | null) => {
    setCollection(c);
    setLimit(PAGE);
  };

  return (
    <section>
      <h2>Saved</h2>
      <p className="muted">
        Everything you saved with Glossly, by collection. Search finds the words, and similar meaning once the embedding model is ready. Nothing here is sent anywhere.
      </p>
      <div className="search">
        <Search size={14} strokeWidth={1.75} aria-hidden />
        <input
          autoFocus
          value={query}
          placeholder="Search saved text, notes, and window titles"
          spellCheck={false}
          onChange={(e) => {
            setQuery(e.target.value);
            setLimit(PAGE);
          }}
        />
      </div>
      {result && (
        <div className="filters" role="radiogroup" aria-label="Collection">
          <button role="radio" aria-checked={collection === null} className={collection === null ? 'filter on' : 'filter'} onClick={() => pick(null)}>
            All <span className="muted">{result.total}</span>
          </button>
          {result.collections.map((c) => (
            <button key={c.name} role="radio" aria-checked={collection === c.name} className={collection === c.name ? 'filter on' : 'filter'} onClick={() => pick(c.name)}>
              {c.name} <span className="muted">{c.count}</span>
            </button>
          ))}
        </div>
      )}
      {result && query && !result.semantic && <p className="muted small">Matching exact words only until the embedding model is ready (Data).</p>}
      {!result ? (
        <p className="muted small">Loading…</p>
      ) : result.items.length === 0 ? (
        <p className="muted small">
          {query ? 'Nothing matches.' : collection ? `Nothing saved in ${collection} yet.` : 'Nothing saved yet. Select text and press Save in the bar.'}
        </p>
      ) : (
        <ul className="list saved-list">
          {result.items.map((it) => (
            <SavedRow key={it.itemId} item={it} collections={names} onChanged={refresh} />
          ))}
        </ul>
      )}
      {result?.more && (
        <div className="row">
          <button onClick={() => setLimit((l) => l + PAGE)}>Show more</button>
        </div>
      )}
    </section>
  );
}
