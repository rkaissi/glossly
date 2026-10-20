// Recall (spec: Actions, Recall) and the search box. Local only: entity matches come from the
// database and similarity from the local embedding model, so nothing here calls a provider.
import type { Embedder } from '../embed/types';
import { canonicalize } from '../people/names';
import type { Settings } from '../settings';
import type { CalendarRepo } from '../store/calendar';
import type { PeopleRepo } from '../store/people';
import type { EntityKind, Store } from '../store/store';
import { isoNow, type Item, type LinkPreview } from '../types';
import type { LibraryItem, LibraryQuery, LibraryResult, RecallHit, RecallReason, SearchResults } from './types';

export interface RecallDeps {
  store: Store;
  /** Null until the local model is loaded; recall then uses entity matches only. */
  embedder: () => Embedder | null;
  settings: () => Pick<Settings, 'recall'>;
}

const MAX_QUERY_CHARS = 2000;
const MAX_HIT_CHARS = 600;
const MIN_TERM_CHARS = 3;
const SEARCH_LIMIT = 8;
const SIDE_LIMIT = 5;

type MatchKind = Extract<EntityKind, 'person' | 'company' | 'product' | 'place'>;
const REASONS: Record<MatchKind, RecallReason> = {
  person: 'same_person',
  company: 'same_company',
  product: 'same_product',
  place: 'same_place',
};
/** Ranking inside entity matches: a shared person beats a shared place. */
const KIND_ORDER: MatchKind[] = ['person', 'company', 'product', 'place'];

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const sameText = (a: string, b: string) => a.replace(/\s+/g, ' ').trim().toLowerCase() === b.replace(/\s+/g, ' ').trim().toLowerCase();
const isWordChar = (c: string | undefined) => c !== undefined && /[\p{L}\p{N}]/u.test(c);

/** True when `term` appears in `hay` as whole words. Both are canonical (see canonicalize). */
export function containsTerm(hay: string, term: string): boolean {
  if (term.length < MIN_TERM_CHARS) return false;
  for (let i = hay.indexOf(term); i >= 0; i = hay.indexOf(term, i + 1)) {
    if (!isWordChar(hay[i - 1]) && !isWordChar(hay[i + term.length])) return true;
  }
  return false;
}

function toHit(item: Item, reason: RecallReason, term: string | null, similarity: number | null): RecallHit {
  return {
    itemId: item.id,
    text: clip(item.text.trim(), MAX_HIT_CHARS),
    why: item.why,
    kind: item.kind,
    source_app: item.source_app,
    window_title: item.window_title,
    created_at: item.created_at,
    reason,
    term,
    similarity,
  };
}

async function nearest(deps: RecallDeps, text: string, k: number, min: number, vector?: Float32Array): Promise<{ item_id: string; similarity: number }[] | null> {
  const embedder = deps.embedder();
  if (!embedder || !deps.store.hasVectors) return null;
  const [v] = vector ? [vector] : await embedder.embed([text.slice(0, MAX_QUERY_CHARS)]);
  if (!v) return null;
  return deps.store.searchVectors(v, k).filter((r) => r.similarity >= min);
}

/**
 * Saved items related to a selection, at most `maxResults`: first items sharing a person,
 * company, product, or place with it, then items similar in meaning above `minSimilarity`.
 * An item with the same text as the selection (it was saved from here) is left out.
 */
export async function recall(deps: RecallDeps, input: { text: string; personIds?: string[]; vector?: Float32Array }): Promise<RecallHit[]> {
  const { store } = deps;
  const settings = deps.settings().recall;
  const max = settings.maxResults;
  const hay = canonicalize(input.text);
  if (!hay) return [];

  const entities = store.matchableEntities();
  const matched = new Map(entities.filter((e) => containsTerm(hay, e.canonical)).map((e) => [e.id, e]));
  // A known person named by an alias (an email or a handle) counts as the same person.
  const byId = new Map(entities.map((e) => [e.id, e]));
  for (const id of store.personEntityIds(input.personIds ?? [])) {
    const e = byId.get(id);
    if (e) matched.set(id, e);
  }

  const picked = new Map<string, { reason: RecallReason; term: string | null; similarity: number | null; rank: number }>();
  for (const link of store.itemsForEntities([...matched.keys()], max * 10)) {
    const e = matched.get(link.entity_id)!;
    const kind = e.kind as MatchKind;
    const rank = KIND_ORDER.indexOf(kind);
    const prev = picked.get(link.item_id);
    if (!prev || rank < prev.rank) picked.set(link.item_id, { reason: REASONS[kind], term: e.display, similarity: null, rank });
  }
  const entityIds = [...picked.entries()].sort((a, b) => a[1].rank - b[1].rank).map(([id]) => id);

  const similar = (await nearest(deps, input.text, max * 3, settings.minSimilarity, input.vector)) ?? [];
  for (const r of similar) {
    if (!picked.has(r.item_id)) picked.set(r.item_id, { reason: 'similar_topic', term: null, similarity: r.similarity, rank: KIND_ORDER.length });
  }
  const order = [...entityIds, ...similar.map((r) => r.item_id).filter((id) => !entityIds.includes(id))];

  return store
    .itemsByIds(order)
    .filter((it) => !sameText(it.text, input.text))
    .slice(0, max)
    .map((it) => {
      const p = picked.get(it.id)!;
      return toHit(it, p.reason, p.term, p.similarity);
    });
}

/**
 * The search box (hotkey with nothing selected): saved items by their words, then by meaning,
 * plus people, open commitments, and upcoming events. An empty query lists the newest saved
 * items, the open commitments, and the next events.
 */
export async function search(deps: RecallDeps & { people: PeopleRepo; calendar?: CalendarRepo }, query: string): Promise<SearchResults> {
  const { store, people } = deps;
  const q = query.replace(/\s+/g, ' ').trim().slice(0, 200);
  const embedderReady = Boolean(deps.embedder()) && store.hasVectors;
  const open = people.commitments({ status: 'open' });
  const today = isoNow().slice(0, 10);
  const events = deps.calendar?.list({ from: today, ...(q && { query: q }), limit: SIDE_LIMIT }) ?? [];

  if (!q) {
    const items = store.itemsByIds(store.recentItemIds(SEARCH_LIMIT)).map((it) => toHit(it, 'text_match', null, null));
    return { query: q, items, people: [], commitments: open.slice(0, SIDE_LIMIT), events, semantic: embedderReady };
  }

  const exact = store.searchItemText(q, SEARCH_LIMIT);
  const similar = (await nearest(deps, q, SEARCH_LIMIT, deps.settings().recall.searchSimilarity)) ?? [];
  const sims = new Map(similar.map((r) => [r.item_id, r.similarity]));
  const ids = [...exact, ...similar.map((r) => r.item_id).filter((id) => !exact.includes(id))].slice(0, SEARCH_LIMIT);
  const items = store
    .itemsByIds(ids)
    .map((it) => (exact.includes(it.id) ? toHit(it, 'text_match', q, null) : toHit(it, 'similar_topic', null, sims.get(it.id) ?? null)));

  const lower = q.toLowerCase();
  const commitments = open.filter((c) => c.text.toLowerCase().includes(lower) || (c.person_name ?? '').toLowerCase().includes(lower));
  return { query: q, items, people: people.list(q).slice(0, SIDE_LIMIT), commitments: commitments.slice(0, SIDE_LIMIT), events, semantic: embedderReady };
}

const LIBRARY_HIT_CHARS = 1500;

const parseJson = <T>(s: string | null): T | null => {
  if (!s) return null;
  try {
    return JSON.parse(s) as T;
  } catch {
    return null;
  }
};

/**
 * The Saved tab (decision 84): with no query, the newest items; with a query, items with those
 * words first, then items close in meaning (`recall.searchSimilarity`). Either way narrowed by
 * type, a linked person, and where it was saved. Each item comes with its page, addresses,
 * preview, links (labelled), and a chart's spec.
 */
export async function library(deps: RecallDeps, q: LibraryQuery): Promise<LibraryResult> {
  const { store } = deps;
  const query = q.query.replace(/\s+/g, ' ').trim().slice(0, 200);
  const limit = Math.max(1, Math.min(q.limit, 500));
  const filter = { kind: q.kind ?? null, personId: q.personId ?? null, source: q.source ?? null };
  const semantic = Boolean(deps.embedder()) && store.hasVectors;
  const base = { query, ...filter, counts: store.kindCounts(), people: store.linkedPeople(), sources: store.itemSources(), semantic };

  let picked: { item: Item; reason: RecallReason; term: string | null; similarity: number | null }[];
  let more: boolean;
  if (!query) {
    const ids = store.libraryItemIds(filter, { limit: limit + 1 });
    picked = store.itemsByIds(ids.slice(0, limit)).map((item) => ({ item, reason: 'text_match', term: null, similarity: null }));
    more = ids.length > limit;
  } else {
    const exact = store.libraryItemIds(filter, { limit: limit + 1, words: query });
    const near = ((await nearest(deps, query, limit * 3, deps.settings().recall.searchSimilarity)) ?? []).filter((r) => !exact.includes(r.item_id));
    const sims = new Map(near.map((r) => [r.item_id, r.similarity]));
    // The meaning matches go through the same filter; their order is by similarity.
    const kept = new Set(store.libraryItemIds(filter, { limit: near.length, within: near.map((r) => r.item_id) }));
    const ids = [...exact, ...near.map((r) => r.item_id).filter((id) => kept.has(id))];
    picked = store
      .itemsByIds(ids.slice(0, limit))
      .map((item) => (sims.has(item.id) ? { item, reason: 'similar_topic', term: null, similarity: sims.get(item.id)! } : { item, reason: 'text_match', term: query, similarity: null }));
    more = ids.length > limit;
  }

  const links = store.itemLinkLabels(picked.map((p) => p.item.id));
  const items: LibraryItem[] = picked.map(({ item, reason, term, similarity }) => {
    const chart = item.kind === 'chart' ? parseJson<{ spec?: Record<string, unknown> | null }>(item.data_json) : null;
    return {
      ...toHit(item, reason, term, similarity),
      text: clip(item.text.trim(), LIBRARY_HIT_CHARS),
      clipped: item.text.trim().length > LIBRARY_HIT_CHARS,
      page: item.page_url || item.page_title ? { url: item.page_url, title: item.page_title } : null,
      urls: parseJson<string[]>(item.urls_json) ?? [],
      preview: parseJson<LinkPreview>(item.preview_json),
      links: links.get(item.id) ?? [],
      chartSpec: chart?.spec ?? null,
    };
  });
  return { ...base, items, more };
}
