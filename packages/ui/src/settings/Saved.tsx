import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import {
  CalendarDays,
  ChartColumn,
  Check,
  CircleCheck,
  Copy,
  ExternalLink,
  Globe,
  Image as ImageIcon,
  LayoutGrid,
  Link2,
  List,
  NotebookPen,
  Pencil,
  Search,
  Sparkles,
  Table,
  TextQuote,
  Trash2,
  UserRound,
  type LucideIcon,
} from 'lucide-react';
import type { ItemLinkKind, LibraryItem, LibraryResult } from '@glossly/core/api';
import { glossly } from '../bridge';
import { drawChart, type ChartView } from '../chart';
import { Select } from '../controls/Select';
import { appName, formatDay } from '../dates';
import { KIND_LABEL, KIND_ORDER, KIND_PLURAL } from '../kinds';
import { useAction } from './useAction';

const PAGE = 30;
const VIEW_KEY = 'glossly.saved.view';
const ANY = '__any__';

type Kind = LibraryItem['kind'];
type ViewMode = 'list' | 'cards';

const KIND_ICON: Record<Kind, LucideIcon> = { selection: TextQuote, link: Link2, chart: ChartColumn, note: Sparkles };
const LINK_ICON: Record<ItemLinkKind, LucideIcon> = { person: UserRound, task: CircleCheck, event: CalendarDays };

/** A source key as a name: a site's host stays as it is, an app's process name becomes "Slack". */
const sourceLabel = (key: string) => (/\.exe$/i.test(key) ? appName(key) : key);
const hostOf = (url: string | null | undefined) => {
  if (!url) return null;
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
};

/** The view the user last picked; browser storage is a convenience, so it may be missing. */
function readView(): ViewMode {
  try {
    return localStorage.getItem(VIEW_KEY) === 'cards' ? 'cards' : 'list';
  } catch {
    return 'list';
  }
}

/** Preview images by item, so switching views or filtering doesn't ask again. */
const imageCache = new Map<string, string | null>();

function usePreviewImage(item: LibraryItem): string | null {
  const name = item.preview?.image ?? null;
  const key = `${item.itemId}:${name}`;
  const [url, setUrl] = useState<string | null>(() => imageCache.get(key) ?? null);
  useEffect(() => {
    if (!name) return;
    if (imageCache.has(key)) {
      setUrl(imageCache.get(key) ?? null);
      return;
    }
    let live = true;
    void glossly.invoke('items:preview-image', { itemId: item.itemId }).then((u) => {
      imageCache.set(key, u);
      if (live) setUrl(u);
    });
    return () => {
      live = false;
    };
  }, [key, name, item.itemId]);
  return name ? url : null;
}

/** The person's record, Tasks, or Calendar: a link chip goes where its target lives. */
function openLink(kind: ItemLinkKind, id: string) {
  location.hash = kind === 'person' ? `people/${encodeURIComponent(id)}` : kind === 'task' ? 'tasks' : 'calendar';
}

function LinkChips({ item }: { item: LibraryItem }) {
  if (item.links.length === 0) return null;
  return (
    <>
      {item.links.map((l) => {
        const Icon = LINK_ICON[l.kind];
        return (
          <button key={`${l.kind}:${l.id}`} className="link-chip" title={l.label} onClick={() => openLink(l.kind, l.id)}>
            <Icon size={12} strokeWidth={1.75} aria-hidden />
            <span>{l.label}</span>
          </button>
        );
      })}
    </>
  );
}

/** "From <page title> <host>", opening the page; for anything saved in a browser. */
function PageLine({ item }: { item: LibraryItem }) {
  if (!item.page) return null;
  const host = hostOf(item.page.url);
  const canOpen = Boolean(item.page.url && /^https?:/i.test(item.page.url));
  const body = (
    <>
      <span className="page-globe">
        <Globe size={11} strokeWidth={1.75} aria-hidden />
      </span>
      <span className="page-title">{item.page.title ?? host ?? 'Page'}</span>
      {host && item.page.title && <span className="page-host">{host}</span>}
      {canOpen && <ExternalLink size={12} strokeWidth={1.75} aria-hidden />}
    </>
  );
  return canOpen ? (
    <button className="page-line" title="Open the page" onClick={() => void glossly.invoke('items:open', { itemId: item.itemId })}>
      {body}
    </button>
  ) : (
    <span className="page-line">{body}</span>
  );
}

/** A saved chart drawn again from its spec, with Copy image and Copy data. */
function ChartBox({ item, onNote }: { item: LibraryItem; onNote: (s: string) => void }) {
  const el = useRef<HTMLDivElement>(null);
  const view = useRef<ChartView | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!item.chartSpec || !el.current) return;
    let live = true;
    let finalize: (() => void) | null = null;
    void drawChart(el.current, item.chartSpec, { width: 'container', autosize: { type: 'fit', contains: 'padding' } })
      .then((r) => {
        if (!live) return r.finalize();
        view.current = r.view;
        finalize = r.finalize;
      })
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
      view.current = null;
      finalize?.();
    };
  }, [item.chartSpec]);
  const copyImage = async () => {
    if (!view.current) return;
    await glossly.invoke('clipboard:image', { dataUrl: await view.current.toImageURL('png', 2) });
    onNote('Chart copied as an image.');
  };
  const copyData = async () => {
    await glossly.invoke('items:copy', { itemId: item.itemId });
    onNote('Table copied as CSV.');
  };
  return (
    <div className="saved-chart">
      {item.chartSpec && !failed ? <div className="saved-chart-plot" ref={el} /> : <pre className="saved-csv clip4">{item.text}</pre>}
      <div className="row-btns">
        {item.chartSpec && !failed && (
          <button className="sm" onClick={() => void copyImage()}>
            <ImageIcon size={14} strokeWidth={1.75} aria-hidden />
            Copy image
          </button>
        )}
        <button className="sm" onClick={() => void copyData()}>
          <Table size={14} strokeWidth={1.75} aria-hidden />
          Copy data
        </button>
      </div>
    </div>
  );
}

/** The quiet note (why it was saved), editable in place; memories are reworded instead. */
function NoteLine({ item, editing, setEditing, onChanged }: { item: LibraryItem; editing: boolean; setEditing: (on: boolean) => void; onChanged: () => void }) {
  const [text, setText] = useState(item.why ?? '');
  const { busy, error, run } = useAction();
  useEffect(() => setText(item.why ?? ''), [item.why]);
  const save = () =>
    void run(async () => {
      await glossly.invoke('save:setWhy', { itemId: item.itemId, why: text.trim() });
      setEditing(false);
      onChanged();
    });
  if (editing)
    return (
      <div className="note-edit">
        <input
          autoFocus
          value={text}
          maxLength={500}
          placeholder="A note for later"
          aria-label="Note"
          disabled={busy}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') save();
            else if (e.key === 'Escape') setEditing(false);
          }}
        />
        <button className="sm primary" disabled={busy} onClick={save}>
          Save
        </button>
        {error && <span className="error small">{error}</span>}
      </div>
    );
  return item.why ? <p className="saved-note small">{item.why}</p> : null;
}

/** Copy, edit (a memory's words, else the note), Load preview for a Link without one, and Delete (trash morphs in place). */
function ItemActions({ item, onChanged, onEditNote, onEditMemory }: { item: LibraryItem; onChanged: () => void; onEditNote: () => void; onEditMemory: () => void }) {
  const [copied, setCopied] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const { busy, error, run } = useAction();
  const copy = () =>
    void run(async () => {
      await glossly.invoke('items:copy', { itemId: item.itemId });
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  const load = () =>
    void run(async () => {
      const p = await glossly.invoke('items:preview', { itemId: item.itemId });
      if (!p) throw new Error('No preview came back. Previews may be off (Privacy), or the page has none.');
      onChanged();
    });
  const del = () =>
    void run(async () => {
      await glossly.invoke('items:delete', { itemId: item.itemId });
      onChanged();
    });
  return (
    <>
      {item.kind === 'link' && !item.preview && (
        <button className="sm ghost" disabled={busy} onClick={load} title="Ask the page for its preview">
          Load preview
        </button>
      )}
      {item.kind === 'note' ? (
        <button className="icon-btn sm" title="Edit this memory" aria-label="Edit this memory" disabled={busy} onClick={onEditMemory}>
          <Pencil size={14} strokeWidth={1.75} aria-hidden />
        </button>
      ) : (
        <button className="icon-btn sm" title={item.why ? 'Edit the note' : 'Add a note'} aria-label={item.why ? 'Edit the note' : 'Add a note'} disabled={busy} onClick={onEditNote}>
          <NotebookPen size={14} strokeWidth={1.75} aria-hidden />
        </button>
      )}
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
      {error && <span className="error small">{error}</span>}
    </>
  );
}

/** Rewording a memory in place (decision 78): a wrong one would feed every later answer. */
function MemoryEditor({ item, onDone }: { item: LibraryItem; onDone: (changed: boolean) => void }) {
  const [text, setText] = useState(item.text);
  const { busy, error, run } = useAction();
  const save = () =>
    void run(async () => {
      if (!text.trim()) throw new Error('A memory needs some text.');
      const r = await glossly.invoke('items:edit', { itemId: item.itemId, text: text.trim() });
      if (!r.edited) throw new Error('That memory is gone.');
      onDone(true);
    });
  return (
    <div className="saved-edit">
      <textarea
        rows={3}
        value={text}
        maxLength={1000}
        autoFocus
        aria-label="Memory"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            save();
          } else if (e.key === 'Escape') onDone(false);
        }}
      />
      <div className="saved-edit-actions">
        <button disabled={busy} onClick={() => onDone(false)}>
          Cancel
        </button>
        <button className="primary" disabled={busy || !text.trim()} onClick={save}>
          Save
        </button>
      </div>
      {error && <p className="error small">{error}</p>}
    </div>
  );
}

/** The body every view shares: a chart, a link's title and quote, or the text; then page, links, note. */
function ItemBody({ item, open, onChanged, editingNote, setEditingNote, onNote }: {
  item: LibraryItem;
  open: boolean;
  onChanged: () => void;
  editingNote: boolean;
  setEditingNote: (on: boolean) => void;
  onNote: (s: string) => void;
}) {
  const linkUrl = item.kind === 'link' ? (item.urls[0] ?? null) : null;
  return (
    <>
      {item.kind === 'chart' ? (
        <ChartBox item={item} onNote={onNote} />
      ) : item.kind === 'link' ? (
        <>
          <button className="link-title" title="Open the page" onClick={() => void glossly.invoke('items:open', { itemId: item.itemId, index: 0 })}>
            {item.preview?.title ?? hostOf(linkUrl) ?? item.text}
          </button>
          {item.preview?.description && <p className="saved-desc small clip2">{item.preview.description}</p>}
        </>
      ) : (
        <p className={`saved-text${open ? '' : ' clip4'}`}>{item.text}</p>
      )}
      <PageLine item={item} />
      <NoteLine item={item} editing={editingNote} setEditing={setEditingNote} onChanged={onChanged} />
    </>
  );
}

const metaLine = (item: LibraryItem, withKind: boolean) =>
  [
    withKind ? KIND_LABEL[item.kind] : null,
    item.kind === 'link' ? hostOf(item.urls[0]) : null,
    formatDay(item.created_at),
    !item.page && item.source_app ? appName(item.source_app) : null,
    item.reason === 'similar_topic' ? 'similar meaning' : null,
  ]
    .filter(Boolean)
    .join(' · ');

/** One item in the list: a type tile (or the preview), the body, its links, then the actions. */
function SavedRow({ item, onChanged }: { item: LibraryItem; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const [editingNote, setEditingNote] = useState(false);
  const [editingMemory, setEditingMemory] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const image = usePreviewImage(item);
  const Icon = KIND_ICON[item.kind];
  const long = item.kind !== 'chart' && (item.clipped || item.text.length > 280 || item.text.split('\n').length > 4);
  return (
    <li className="saved-row">
      <span className={`kind-tile${image ? ' thumb' : ''}`} title={KIND_LABEL[item.kind]}>
        {image ? <img src={image} alt="" /> : <Icon size={16} strokeWidth={1.75} aria-hidden />}
      </span>
      <div className="saved-body">
        {editingMemory ? (
          <MemoryEditor
            item={item}
            onDone={(changed) => {
              setEditingMemory(false);
              if (changed) onChanged();
            }}
          />
        ) : (
          <ItemBody item={item} open={open} onChanged={onChanged} editingNote={editingNote} setEditingNote={setEditingNote} onNote={setNote} />
        )}
        {long && !editingMemory && (
          <button className="link small" onClick={() => setOpen((o) => !o)}>
            {open ? 'Show less' : item.clipped ? 'Show more (Copy copies all of it)' : 'Show more'}
          </button>
        )}
        <div className="saved-meta">
          <span className="muted small">{metaLine(item, true)}</span>
          <LinkChips item={item} />
          <span className="spacer" />
          <ItemActions item={item} onChanged={onChanged} onEditNote={() => setEditingNote(true)} onEditMemory={() => setEditingMemory(true)} />
        </div>
        {note && <p className="muted small">{note}</p>}
      </div>
    </li>
  );
}

/** One item as a tile: a link's preview (or the globe), a chart wide, everything else as text. */
function SavedCard({ item, onChanged }: { item: LibraryItem; onChanged: () => void }) {
  const [editingNote, setEditingNote] = useState(false);
  const [editingMemory, setEditingMemory] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const image = usePreviewImage(item);
  const Icon = KIND_ICON[item.kind];
  const visual = item.kind === 'link';
  return (
    <div className={`tile${item.kind === 'chart' ? ' wide' : ''}${visual ? ' link' : ''}`}>
      {visual && <div className={`tile-preview${image ? '' : ' empty'}`}>{image ? <img src={image} alt="" /> : <Globe size={30} strokeWidth={1.25} aria-hidden />}</div>}
      <div className="tile-body">
        {!visual && (
          <div className="tile-head muted small">
            <Icon size={14} strokeWidth={1.75} aria-hidden />
            {KIND_LABEL[item.kind]}
          </div>
        )}
        {editingMemory ? (
          <MemoryEditor
            item={item}
            onDone={(changed) => {
              setEditingMemory(false);
              if (changed) onChanged();
            }}
          />
        ) : (
          <ItemBody item={item} open={false} onChanged={onChanged} editingNote={editingNote} setEditingNote={setEditingNote} onNote={setNote} />
        )}
        {item.links.length > 0 && (
          <div className="tile-links">
            <LinkChips item={item} />
          </div>
        )}
        <div className="saved-meta">
          <span className="muted small">{metaLine(item, false)}</span>
          <span className="spacer" />
          <ItemActions item={item} onChanged={onChanged} onEditNote={() => setEditingNote(true)} onEditMemory={() => setEditingMemory(true)} />
        </div>
        {note && <p className="muted small">{note}</p>}
      </div>
    </div>
  );
}

/**
 * Cards pack like a bento box (masonry, decision 84): the grid's rows are 1 px, and each tile
 * spans its own height plus the gap, measured whenever a tile or the grid changes size.
 */
function Bento({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const pack = useCallback(() => {
    const grid = ref.current;
    if (!grid) return;
    const gap = Number.parseFloat(getComputedStyle(grid).columnGap) || 12;
    for (const tile of grid.children as HTMLCollectionOf<HTMLElement>) {
      tile.style.gridRowEnd = 'auto';
      tile.style.gridRowEnd = `span ${Math.ceil(tile.getBoundingClientRect().height + gap)}`;
    }
  }, []);
  useLayoutEffect(() => {
    const grid = ref.current;
    if (!grid) return;
    pack();
    const ro = new ResizeObserver(() => pack());
    ro.observe(grid);
    for (const tile of grid.children) ro.observe(tile);
    return () => ro.disconnect();
  });
  return (
    <div className="bento" ref={ref}>
      {children}
    </div>
  );
}

/**
 * Settings > Saved (decision 84): everything saved, by type (Snippets, Links, Charts, Memories),
 * a linked person, and the app or site, searched by words and then by meaning, in a list or as
 * cards. Nothing here calls a model provider; a preview is fetched only on Load preview.
 */
export function SavedTab() {
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState<Kind | null>(null);
  const [personId, setPersonId] = useState<string | null>(null);
  const [source, setSource] = useState<string | null>(null);
  const [view, setView] = useState<ViewMode>(readView);
  const [limit, setLimit] = useState(PAGE);
  const [result, setResult] = useState<LibraryResult | null>(null);
  const [tick, setTick] = useState(0);
  const seq = useRef(0);

  useEffect(() => {
    const n = ++seq.current;
    // A short pause while typing, none for a filter or a refresh.
    const t = setTimeout(
      () => void glossly.invoke('library:query', { query, kind, personId, source, limit }).then((r) => n === seq.current && setResult(r)),
      query ? 150 : 0,
    );
    return () => clearTimeout(t);
  }, [query, kind, personId, source, limit, tick]);

  // Items saved from the overlay while this tab is open show up when the window comes back.
  useEffect(() => {
    const refresh = () => setTick((x) => x + 1);
    window.addEventListener('focus', refresh);
    return () => window.removeEventListener('focus', refresh);
  }, []);

  const refresh = () => setTick((x) => x + 1);
  const pickView = (v: ViewMode) => {
    setView(v);
    try {
      localStorage.setItem(VIEW_KEY, v);
    } catch {
      /* the view just isn't remembered */
    }
  };
  const narrowed = <T,>(set: (v: T) => void) => (v: T) => {
    set(v);
    setLimit(PAGE);
  };
  const people = result?.people ?? [];
  const sources = result?.sources ?? [];
  const filtered = Boolean(query || kind || personId || source);

  return (
    <section className="saved-tab">
      <h2>Saved</h2>
      <p className="muted">Everything you saved, and what Ask remembered. Glossly uses it in answers, replies, and Write here. Search finds the words, and similar meaning once the embedding model is ready. Nothing here is sent anywhere.</p>
      <div className="saved-tools">
        <div className="search">
          <Search size={14} strokeWidth={1.75} aria-hidden />
          <input
            autoFocus
            value={query}
            placeholder="Search words or meaning"
            spellCheck={false}
            onChange={(e) => {
              setQuery(e.target.value);
              setLimit(PAGE);
            }}
          />
        </div>
        <Select
          size="sm"
          label="Person"
          value={personId ?? ANY}
          onChange={narrowed((v: string) => setPersonId(v === ANY ? null : v))}
          options={[{ value: ANY, label: 'Anyone' }, ...people.map((p) => ({ value: p.id, label: p.name, hint: String(p.count) }))]}
          disabled={people.length === 0 && !personId}
        />
        <Select
          size="sm"
          label="App or site"
          value={source ?? ANY}
          onChange={narrowed((v: string) => setSource(v === ANY ? null : v))}
          options={[{ value: ANY, label: 'Any app or site' }, ...sources.map((s) => ({ value: s.key, label: sourceLabel(s.key), hint: String(s.count) }))]}
          disabled={sources.length === 0 && !source}
        />
        <div className="view-switch" role="radiogroup" aria-label="View">
          <button role="radio" aria-checked={view === 'list'} className={`icon-btn sm${view === 'list' ? ' open' : ''}`} title="List" aria-label="List" onClick={() => pickView('list')}>
            <List size={14} strokeWidth={1.75} aria-hidden />
          </button>
          <button role="radio" aria-checked={view === 'cards'} className={`icon-btn sm${view === 'cards' ? ' open' : ''}`} title="Cards" aria-label="Cards" onClick={() => pickView('cards')}>
            <LayoutGrid size={14} strokeWidth={1.75} aria-hidden />
          </button>
        </div>
      </div>
      {result && (
        <div className="filters" role="radiogroup" aria-label="Type">
          <button role="radio" aria-checked={kind === null} className={kind === null ? 'filter on' : 'filter'} onClick={() => narrowed(setKind)(null)}>
            All <span className="muted">{result.counts.all}</span>
          </button>
          {KIND_ORDER.map((k) => {
            const Icon = KIND_ICON[k];
            return (
              <button key={k} role="radio" aria-checked={kind === k} className={kind === k ? 'filter on' : 'filter'} onClick={() => narrowed(setKind)(k)}>
                <Icon size={13} strokeWidth={1.75} aria-hidden />
                {KIND_PLURAL[k]} <span className="muted">{result.counts[k]}</span>
              </button>
            );
          })}
        </div>
      )}
      {result && query && !result.semantic && <p className="muted small">Matching exact words only until the embedding model is ready (Privacy).</p>}
      {!result ? (
        <p className="muted small">Loading…</p>
      ) : result.items.length === 0 ? (
        <p className="muted small">{filtered ? 'Nothing matches.' : 'Nothing saved yet. Select text and press Save in the bar.'}</p>
      ) : view === 'list' ? (
        <ul className="list saved-list">
          {result.items.map((it) => (
            <SavedRow key={it.itemId} item={it} onChanged={refresh} />
          ))}
        </ul>
      ) : (
        <Bento>
          {result.items.map((it) => (
            <SavedCard key={it.itemId} item={it} onChanged={refresh} />
          ))}
        </Bento>
      )}
      {result?.more && (
        <div className="row">
          <button onClick={() => setLimit((l) => l + PAGE)}>Show more</button>
        </div>
      )}
    </section>
  );
}
